import { expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { discoverModelCatalog } from "../../src/ai/model-catalog.js";
import { generateModelText, type ModelGenerationInput } from "../../src/ai/model-client.js";
import { createModelTransport, isPublicModelAddress } from "../../src/ai/model-transport.js";
import { endpointDigest } from "../../src/ai/provider-presets.js";
import { Blocked } from "../../src/core/contracts.js";

const apiKey = "synthetic-private-key";
const privateResponse = "synthetic-private-provider-body";

test.each(["3ffe::1", "2001:db8::1", "2002:7f00:1::1", "2001:10::1", "2001:20::1", "5f00::1",
  "3fff::1", "3000::1", "2001:1000::1", "2622::1"])("public HTTPS rejects nonpublic IPv6 %s", address => {
  expect(isPublicModelAddress(address)).toBe(false);
});

test.each(["2001:4860::8888", "2606:4700::1111", "2a12::1"])("public HTTPS accepts allocated IPv6 %s", address => {
  expect(isPublicModelAddress(address)).toBe(true);
});
const baseUrl = "https://models.example.com/v1";
const url = baseUrl + "/chat/completions";
const route = {
  connectionId: "00000000-0000-4000-8000-000000000001", credentialRevision: "00000000-0000-4000-8000-000000000002",
  routeRevision: 1, protocol: "OPENAI_CHAT", presetId: "custom",
} as const;

function input(transport: typeof fetch): ModelGenerationInput {
  return {
    transport, apiKey, messages: [{ role: "user", content: "Synthetic" }],
    revision: { ...route, baseUrl, region: null, createdAt: 0, storage: "MEMORY" },
    snapshot: { ...route, endpointDigest: endpointDigest(baseUrl), modelId: "example-model",
      purpose: "SANDBOX_REPLY", grantVersion: 1, selectionRevision: 1 },
  };
}

const success = JSON.stringify({
  id: "test-completion", model: "reported-model", created: 0,
  choices: [{ message: { role: "assistant", content: "Works" }, index: 0, finish_reason: "stop" }],
});

async function expectSafeFailure(operation: Promise<unknown>, code: string, status?: number) {
  const error: unknown = await operation.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Blocked);
  expect(error).toMatchObject(status === undefined ? { code } : { code, status });
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  expect(serialized).not.toContain(apiKey);
  expect(serialized).not.toContain(privateResponse);
}

test("generation accepts exactly 64,000 bytes and forwards just one request", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(success.padEnd(64_000)));
  const result = await generateModelText(input(transport));
  expect(result.text).toBe("Works");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]![0]).toBe(url);
});

test.each([
  [401, "MODEL_AUTH_FAILED"], [403, "MODEL_REQUEST_UNSUPPORTED"], [404, "MODEL_NOT_AVAILABLE"],
  [429, "MODEL_RATE_LIMITED"], [500, "MODEL_SERVICE_ERROR"], [503, "MODEL_SERVICE_ERROR"],
] as const)("HTTP %i produces %s and does not retry or expose the response", async (status, code) => {
  const transport = vi.fn<typeof fetch>(async () => new Response(privateResponse + apiKey, {
    status, headers: { "x-private": apiKey, "retry-after": "0" },
  }));
  await expectSafeFailure(generateModelText(input(transport)), code, status);
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([200, 307, 700, 101])("production HTTPS pins DNS, preserves TLS identity and handles status %i", async status => {
  const answers = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700::1111", family: 6 }];
  const lookup = vi.fn(async () => answers);
  const beforeRequest = vi.fn();
  const incoming = Object.assign(new PassThrough(), { statusCode: status });
  const dial = vi.spyOn(https, "request").mockImplementation((...args) => {
    const onResponse = args[2] as (value: IncomingMessage) => void;
    const outgoing = Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => {
        if (status === 101) {
          // Node closes an unsolicited upgrade without emitting a response event.
          incoming.destroy();
          outgoing.emit("close");
          return;
        }
        onResponse(incoming as unknown as IncomingMessage);
        if (!incoming.destroyed) incoming.end(success);
      }),
    });
    return outgoing as unknown as ClientRequest;
  });
  try {
    const result = generateModelText({ ...input(globalThis.fetch), lookup, beforeRequest });
    if (status === 200) expect((await result).text).toBe("Works");
    else if (status === 307) await expectSafeFailure(result, "MODEL_REDIRECT_REJECTED", 307);
    else await expectSafeFailure(result, "MODEL_NETWORK_ERROR");
    expect(dial).toHaveBeenCalledOnce();
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(beforeRequest).toHaveBeenCalledBefore(dial);
    const [destination, options] = dial.mock.calls[0]!;
    expect(String(destination)).toBe(url);
    expect(options).toMatchObject({ agent: false, servername: "models.example.com", rejectUnauthorized: true });
    const pinned = vi.fn();
    (options as https.RequestOptions).lookup!("models.example.com", { all: true }, pinned);
    expect(pinned).toHaveBeenCalledExactlyOnceWith(null, answers);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("models.example.com", { all: true });
    expect(incoming.destroyed).toBe(true);
  } finally { dial.mockRestore(); }
});

test("a route invalidated during DNS resolution is rejected by the last gate before HTTPS dials", async () => {
  let revision = 1;
  const lookup = vi.fn(async () => {
    revision++;
    return [{ address: "8.8.8.8", family: 4 }];
  });
  const beforeRequest = vi.fn(() => {
    if (revision !== route.routeRevision) throw new Blocked("MODEL_ROUTE_CHANGED");
  });
  const dial = vi.spyOn(https, "request").mockImplementation(() => { throw new Error("unexpected dial"); });
  try {
    await expectSafeFailure(generateModelText({ ...input(globalThis.fetch), lookup, beforeRequest }), "MODEL_ROUTE_CHANGED");
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledBefore(beforeRequest);
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(dial).not.toHaveBeenCalled();
  } finally { dial.mockRestore(); }
});

test("catalog rechecks the route before each page and stops before sending a stale second request", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    data: [{ id: "claude-fixture" }], has_more: true, last_id: "next-page",
  }));
  const beforeRequest = vi.fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => { throw new Blocked("MODEL_ROUTE_CHANGED"); });
  const call = input(transport);
  const { catalog } = await discoverModelCatalog({ ...call, beforeRequest,
    revision: { ...call.revision, presetId: "anthropic", protocol: "ANTHROPIC_MESSAGES" },
  });
  expect(catalog).toMatchObject({ status: "PARTIAL", reason: "MODEL_ROUTE_CHANGED", models: [{ modelId: "claude-fixture" }] });
  expect(beforeRequest).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledOnce();
});

test("a network rejection is fixed and does not retry", async () => {
  const transport = vi.fn<typeof fetch>(async () => { throw new Error(privateResponse + apiKey); });
  await expectSafeFailure(generateModelText(input(transport)), "MODEL_NETWORK_ERROR");
  expect(transport).toHaveBeenCalledTimes(1);
});

test("malformed JSON does not leak SDK exception text", async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response(privateResponse + apiKey));
  await expectSafeFailure(generateModelText(input(transport)), "MODEL_RESPONSE_INVALID");
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([301, 302, 303, 307, 308])("rejects HTTP %i and sends zero requests to Location", async status => {
  const destination = "https://redirect.example.com/receive";
  const redirected = vi.fn<typeof fetch>();
  const transport = vi.fn<typeof fetch>(async (requested, init) => {
    if (String(requested) === destination || !["manual", "error"].includes(init?.redirect ?? "follow")) {
      return redirected(destination, init);
    }
    return new Response(privateResponse, { status, headers: { location: destination } });
  });
  await expectSafeFailure(generateModelText(input(transport)), "MODEL_REDIRECT_REJECTED", status);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(redirected).not.toHaveBeenCalled();
});

test("a stalled response body consumes the same 30-second deadline as the POST", async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>(() => new Promise(resolve => setTimeout(() =>
      resolve(new Response(new ReadableStream({ cancel }))), 25_000)));
    const failure = expectSafeFailure(generateModelText(input(transport)), "MODEL_TIMEOUT");
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("caller cancellation short-circuits or interrupts the single POST", async () => {
  const starting = new AbortController();
  starting.abort(new Error(apiKey));
  const transport = vi.fn<typeof fetch>(async () => new Promise(() => {}));
  await expectSafeFailure(generateModelText({ ...input(transport), signal: starting.signal }), "MODEL_ROUTE_CHANGED");
  expect(transport).not.toHaveBeenCalled();
  const active = new AbortController();
  let ready!: () => void;
  const called = new Promise<void>(resolve => { ready = resolve; });
  transport.mockImplementationOnce(async () => { ready(); return new Promise(() => {}); });
  const failure = expectSafeFailure(generateModelText({ ...input(transport), signal: active.signal }), "MODEL_ROUTE_CHANGED");
  await called;
  active.abort(new Error(privateResponse));
  await failure;
  expect(transport).toHaveBeenCalledTimes(1);
});

test("streamed UTF-8 bytes above 64,000 are rejected even with a smaller declared length", async () => {
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode("好".repeat(21_334));
  const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 32_000));
      controller.enqueue(bytes.subarray(32_000));
    },
    cancel,
  }), { headers: { "content-length": "1" } }));
  await expectSafeFailure(generateModelText(input(transport)), "MODEL_RESPONSE_TOO_LARGE");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledOnce();
});

test("changed route identity or a private endpoint is blocked before calling injected transport", async () => {
  const transport = vi.fn<typeof fetch>();
  for (const [overrides, code] of [
    [{ baseUrl: "https://other.example.com/v1" }, "MODEL_ROUTE_CHANGED"],
    [{ routeRevision: 2 }, "MODEL_ROUTE_CHANGED"],
    [{ presetId: "deepseek" }, "MODEL_ROUTE_CHANGED"],
    [{ baseUrl: "https://127.0.0.1/v1" }, "MODEL_REQUEST_UNSUPPORTED"],
  ] as const) {
    const call = input(transport);
    await expectSafeFailure(generateModelText({ ...call, revision: { ...call.revision, ...overrides } }), code);
  }
  expect(transport).not.toHaveBeenCalled();
});

test("the SDK fetch boundary refuses any URL or method besides the bound operation", async () => {
  const transport = vi.fn<typeof fetch>();
  const signal = new AbortController().signal;
  for (const [destination, method] of [
    ["https://other.example.com/v1/chat/completions", "POST"], [baseUrl + "/responses", "POST"],
    [url + "?key=unexpected", "POST"], [url, "GET"],
  ] as const) {
    const wire = createModelTransport(url, "POST", signal, transport);
    await expectSafeFailure(wire.fetch(destination, { method }), "MODEL_ROUTE_CHANGED");
  }
  expect(transport).not.toHaveBeenCalled();
});

test.each([
  ["10.2.3.4", 4], ["127.0.0.1", 4], ["169.254.169.254", 4], ["100.64.0.1", 4], ["0.0.0.0", 4],
  ["::1", 6], ["fc00::1", 6], ["fe80::1", 6], ["::ffff:8.8.8.8", 6], ["2002::1", 6],
])("generation and catalog reject mixed public and non-public DNS answers (%s) before dialing", async (address, family) => {
  const fallback = vi.fn<typeof fetch>(async () => new Response(success));
  const dial = vi.spyOn(https, "request").mockImplementation(() => { throw new Error("unexpected dial"); });
  vi.stubGlobal("fetch", fallback);
  try {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }, { address, family }]);
    const call = { ...input(globalThis.fetch), lookup };
    await expectSafeFailure(generateModelText(call), "MODEL_REQUEST_UNSUPPORTED");
    const { catalog } = await discoverModelCatalog({ ...call, transport: undefined });
    expect(catalog).toMatchObject({ status: "FAILED", reason: "MODEL_REQUEST_UNSUPPORTED", models: [] });
    expect(lookup.mock.calls).toEqual([
      ["models.example.com", { all: true }], ["models.example.com", { all: true }],
    ]);
    expect(fallback).not.toHaveBeenCalled();
    expect(dial).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    dial.mockRestore();
  }
});
