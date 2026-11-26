import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { Blocked } from "../core/contracts.js";
import type { ModelErrorCode } from "./model-contracts.js";

const GENERATION_BYTES = 64_000;
const CATALOG_PAGE_BYTES = 2 * 1024 * 1024;
const nativeFetch = globalThis.fetch;

// Special-purpose ranges are excluded from the public HTTPS policy.
const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonPublic.addSubnet(address, prefix, "ipv4");
// RIR allocations from the IANA IPv6 Global Unicast Address Space registry.
// The allowlist excludes IETF special-purpose, 6to4, and unallocated or returned space.
const publicIpv6 = new BlockList();
for (const [address, prefix] of [
  ["2001:200::", 23], ["2001:400::", 23], ["2001:600::", 23], ["2001:800::", 22],
  ["2001:c00::", 23], ["2001:e00::", 23], ["2001:1200::", 23], ["2001:1400::", 22],
  ["2001:1800::", 23], ["2001:1a00::", 23], ["2001:1c00::", 22], ["2001:2000::", 19],
  ["2001:4000::", 23], ["2001:4200::", 23], ["2001:4400::", 23], ["2001:4600::", 23],
  ["2001:4800::", 23], ["2001:4a00::", 23], ["2001:4c00::", 23], ["2001:5000::", 20],
  ["2001:8000::", 19], ["2001:a000::", 20], ["2001:b000::", 20], ["2003::", 18],
  ["2400::", 11], ["2600::", 12], ["2610::", 23], ["2620::", 23], ["2630::", 12],
  ["2800::", 12], ["2a00::", 11], ["2c00::", 12],
] as const) publicIpv6.addSubnet(address, prefix, "ipv6");
// Documentation space sits inside the APNIC allocation.
nonPublic.addSubnet("2001:db8::", 32, "ipv6");

export function isPublicModelAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !nonPublic.check(address, "ipv4");
  return family === 6 && !address.includes("%") && publicIpv6.check(address, "ipv6") && !nonPublic.check(address, "ipv6");
}

export class ModelError extends Blocked {
  declare readonly code: ModelErrorCode;

  constructor(code: ModelErrorCode, readonly status?: number, message: string = code) {
    super(code);
    this.name = "ModelError";
    this.message = message;
  }
}

type ModelLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export type ModelFetchOptions = {
  transport?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  lookup?: ModelLookup | undefined;
};

export function requireModelKey(key: string | null | undefined): string {
  if (typeof key !== "string" || !key.trim() || key.length > 4000 || /[^\x20-\x7e]/u.test(key)) {
    throw new ModelError("MODEL_KEY_REQUIRED");
  }
  return key;
}

export async function withModelDeadline<T>(
  operation: "generation" | "catalog",
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => {
    const reason: unknown = callerSignal?.reason;
    controller.abort(reason instanceof Blocked && ["MODEL_CANCELLED", "MODEL_ROUTE_CHANGED", "EMERGENCY_STOPPED"].includes(reason.code)
      ? reason : new ModelError("MODEL_ROUTE_CHANGED"));
  };
  if (callerSignal?.aborted) cancel();
  controller.signal.throwIfAborted();
  callerSignal?.addEventListener("abort", cancel, { once: true });

  const timeout = operation === "generation" ? 30_000 : 15_000;
  const timer = setTimeout(() => controller.abort(new ModelError("MODEL_TIMEOUT")), timeout);
  let rejectOnAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    const result = await Promise.race([run(controller.signal), aborted]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

function errorForStatus(status: number): ModelError {
  if (status >= 300 && status < 400) return new ModelError("MODEL_REDIRECT_REJECTED", status);
  if (status === 401) return new ModelError("MODEL_AUTH_FAILED", status);
  if (status === 404) return new ModelError("MODEL_NOT_AVAILABLE", status);
  if (status === 429) return new ModelError("MODEL_RATE_LIMITED", status);
  if (status >= 500) return new ModelError("MODEL_SERVICE_ERROR", status);
  return new ModelError("MODEL_REQUEST_UNSUPPORTED", status);
}

async function readBoundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Response> {
  if (!response.body) throw new ModelError("MODEL_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const bytes = new Uint8Array(limit);
  let length = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (length + value.byteLength > limit) throw new ModelError("MODEL_RESPONSE_TOO_LARGE");
      bytes.set(value, length);
      length += value.byteLength;
    }
    return new Response(bytes.subarray(0, length), { status: response.status, headers: { "content-type": "application/json" } });
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function prepareHttpsRequest(request: Request, resolve: ModelLookup): Promise<() => Promise<Response>> {
  const url = new URL(request.url);
  if (url.protocol !== "https:") throw new ModelError("MODEL_REQUEST_UNSUPPORTED");
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(hostname);
  const resolved = family ? [{ address: hostname, family }] : await resolve(hostname, { all: true });
  if (!resolved.length || resolved.some(({ address, family }) => isIP(address) !== family || !isPublicModelAddress(address))) {
    throw new ModelError("MODEL_REQUEST_UNSUPPORTED");
  }
  const addresses = resolved.map(({ address, family }) => ({ address, family }));
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };

  const headers = request.headers;
  headers.delete("host");
  headers.set("accept-encoding", "identity");
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body) headers.set("content-length", String(body.byteLength));
  return () => new Promise((resolveResponse, reject) => {
    const outgoing = https.request(url, {
      method: request.method, headers: Object.fromEntries(headers), signal: request.signal,
      // Fresh connection, with the URL hostname still used for TLS identity and Host.
      agent: false, lookup: pinnedLookup, rejectUnauthorized: true,
      ...(family ? {} : { servername: hostname.replace(/\.$/u, "") }),
    }, incoming => {
      const status = incoming.statusCode ?? 500;
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new ModelError("MODEL_NETWORK_ERROR"));
        return;
      }
      if (status >= 300 || status === 204 || status === 205) {
        incoming.destroy();
        resolveResponse(new Response(null, { status }));
        return;
      }
      const stream = Readable.toWeb(incoming, { strategy: {
        highWaterMark: incoming.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength,
      } });
      // Node's stream adapter returns a web stream, whose declarations differ from the DOM types.
      resolveResponse(new Response(stream as unknown as ReadableStream<Uint8Array>, { status }));
    });
    outgoing.once("error", reject);
    outgoing.once("close", () => reject(new ModelError("MODEL_NETWORK_ERROR")));
    outgoing.end(body);
  });
}

// The caller supplies the exact operation URL derived from its validated revision.
// Each instance has a single network attempt, even if the SDK asks to continue.
export function createModelTransport(
  expectedUrl: string,
  method: "POST" | "GET",
  signal: AbortSignal,
  transport?: typeof fetch,
  beforeRequest?: () => void,
  lookup: ModelLookup = dnsLookup,
): { fetch: typeof fetch; readonly failure: Blocked | undefined } {
  let attempted = false;
  let failure: Blocked | undefined;
  const guardedFetch: typeof fetch = async (input, init) => {
    try {
      signal.throwIfAborted();
      const requestUrl = input instanceof Request ? input.url : String(input);
      const requestMethod = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (requestUrl !== expectedUrl || requestMethod !== method) throw new ModelError("MODEL_ROUTE_CHANGED");
      if (attempted) throw new ModelError("MODEL_OUTPUT_INCOMPLETE");
      attempted = true;

      // Production callers may explicitly pass the built-in fetch. Only a synthetic override bypasses DNS.
      const options: RequestInit = { ...init, method, redirect: "manual", signal };
      const send = !transport || transport === nativeFetch || transport === globalThis.fetch
        ? await prepareHttpsRequest(new Request(input, options), lookup)
        : () => transport(input, options);
      signal.throwIfAborted();
      beforeRequest?.();
      signal.throwIfAborted();
      let response: Response;
      try {
        // Manual mode exposes the status while keeping Location entirely out of the request path.
        response = await send();
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.name === "TimeoutError") throw new ModelError("MODEL_TIMEOUT");
        throw new ModelError("MODEL_NETWORK_ERROR");
      }
      if (signal.aborted || !response.ok || response.redirected || response.type === "opaqueredirect") {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
        if (response.redirected || response.type === "opaqueredirect") throw new ModelError("MODEL_REDIRECT_REJECTED");
        throw errorForStatus(response.status);
      }
      return await readBoundedBody(response, method === "POST" ? GENERATION_BYTES : CATALOG_PAGE_BYTES, signal);
    } catch (error) {
      failure ??= error instanceof Blocked ? error : new ModelError("MODEL_NETWORK_ERROR");
      throw failure;
    }
  };
  return { fetch: guardedFetch, get failure() { return failure; } };
}
