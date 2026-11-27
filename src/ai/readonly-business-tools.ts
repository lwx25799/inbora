import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  BUSINESS_TOOL_IDS,
  type AccountAiFeatures,
  type BusinessToolId,
} from "../contracts/ai-runtime.js";
import { modelBaseUrlSchema } from "../contracts/model-providers.js";
import { Blocked } from "../core/contracts.js";
import { isPublicModelAddress } from "./model-transport.js";

const TOOL_TIMEOUT_MS = 10_000;
const TOOL_MAX_RESPONSE_BYTES = 32 * 1024;
const nativeFetch = globalThis.fetch;

type ToolLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export interface InvokeBusinessToolInput {
  accountFeatures: AccountAiFeatures;
  toolId: BusinessToolId | string;
  params: Record<string, string>;
  method?: string;
  transport?: typeof fetch;
  lookup?: ToolLookup;
  signal?: AbortSignal;
}

export interface BusinessToolResult {
  toolId: BusinessToolId;
  status: number;
  data: unknown;
  redacted: true;
}

const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|session|credential|phone|mobile|tel|id[_-]?card|identity|bank|card[_-]?no|address|email|open[_-]?id|union[_-]?id)/iu;

function redactString(value: string): string {
  return value
    .replace(/\b1[3-9]\d{9}\b/gu, "[REDACTED_PHONE]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, "[REDACTED_EMAIL]")
    .replace(/\b\d{15,18}[\dXx]\b/gu, "[REDACTED_ID]");
}

function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactPayload(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactPayload(val, depth + 1);
      }
    }
    return out;
  }
  return null;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  void promise.catch(() => {});
  if (signal.aborted) return Promise.reject(new Blocked("BUSINESS_TOOL_FAILED"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Blocked("BUSINESS_TOOL_FAILED"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolvePublicAddresses(url: URL, resolve: ToolLookup, signal: AbortSignal): Promise<LookupAddress[]> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Blocked("BUSINESS_TOOL_FORBIDDEN");
  }
  if (signal.aborted) {
    throw new Blocked("BUSINESS_TOOL_FAILED");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(hostname);
  let resolved: LookupAddress[];
  try {
    resolved = family
      ? [{ address: hostname, family }]
      : await raceWithAbort(resolve(hostname, { all: true }), signal);
  } catch (error) {
    if (error instanceof Blocked) throw error;
    throw new Blocked("BUSINESS_TOOL_FAILED");
  }
  if (!resolved.length || resolved.some(({ address, family: fam }) => isIP(address) !== fam || !isPublicModelAddress(address))) {
    throw new Blocked("BUSINESS_TOOL_FORBIDDEN");
  }
  return resolved.map(({ address, family: fam }) => ({ address, family: fam }));
}

function isBodylessSuccessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function sendPinnedHttpsGet(url: URL, addresses: LookupAddress[], signal: AbortSignal): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(hostname);
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  return new Promise((resolveResponse, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Blocked("BUSINESS_TOOL_FAILED"));
    };
    const outgoing = https.request(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
      },
      signal,
      agent: false,
      lookup: pinnedLookup,
      rejectUnauthorized: true,
      ...(family ? {} : { servername: hostname.replace(/\.$/u, "") }),
    }, incoming => {
      try {
        const status = incoming.statusCode ?? 500;
        if (status < 200 || status >= 300 || isBodylessSuccessStatus(status)) {
          incoming.destroy();
          fail();
          return;
        }
        const stream = Readable.toWeb(incoming, {
          strategy: {
            highWaterMark: incoming.readableHighWaterMark,
            size: (chunk: Uint8Array) => chunk.byteLength,
          },
        });
        if (!settled) {
          settled = true;
          resolveResponse(new Response(stream as unknown as ReadableStream<Uint8Array>, { status }));
        }
      } catch {
        try { incoming.destroy(); } catch { /* ignore */ }
        fail();
      }
    });
    outgoing.once("error", fail);
    outgoing.once("close", fail);
    outgoing.end();
  });
}

async function readBoundedToolJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Blocked("BUSINESS_TOOL_FAILED");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(TOOL_MAX_RESPONSE_BYTES);
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (length + value.byteLength > TOOL_MAX_RESPONSE_BYTES) {
        throw new Blocked("BUSINESS_TOOL_FAILED");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    const text = new TextDecoder().decode(bytes.subarray(0, length));
    return JSON.parse(text);
  } catch (error) {
    cancel();
    if (error instanceof Blocked) throw error;
    throw new Blocked("BUSINESS_TOOL_FAILED");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Whitelisted read-only external business tool invoker (orders, logistics, inventory).
 * Enforces GET-only, public HTTPS + deadline-bounded DNS SSRF check, redirect rejection,
 * 10s timeout, maxRetries=0, 32 KiB response cap, and field/pattern redaction.
 */
export async function invokeReadonlyBusinessTool(input: InvokeBusinessToolInput): Promise<BusinessToolResult> {
  const method = (input.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    throw new Blocked("BUSINESS_TOOL_FORBIDDEN");
  }
  if (!BUSINESS_TOOL_IDS.includes(input.toolId as BusinessToolId)) {
    throw new Blocked("BUSINESS_TOOL_FORBIDDEN");
  }
  const toolId = input.toolId as BusinessToolId;
  if (!input.accountFeatures.enabledBusinessTools.includes(toolId)) {
    throw new Blocked("BUSINESS_TOOL_FORBIDDEN");
  }
  const endpoint = input.accountFeatures.toolEndpoints[toolId];
  if (!endpoint) {
    throw new Blocked("BUSINESS_TOOL_NOT_CONFIGURED");
  }
  if (!modelBaseUrlSchema.safeParse(endpoint).success) {
    throw new Blocked("BUSINESS_TOOL_FORBIDDEN");
  }

  const targetUrl = new URL(endpoint);
  for (const [key, value] of Object.entries(input.params)) {
    if (key.length > 0 && key.length <= 40 && typeof value === "string" && value.length <= 200) {
      targetUrl.searchParams.set(key, value);
    }
  }

  const timeoutSignal = AbortSignal.timeout(TOOL_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const addresses = await resolvePublicAddresses(targetUrl, input.lookup ?? dnsLookup, signal);

  let response: Response;
  try {
    const customTransport = input.transport && input.transport !== nativeFetch && input.transport !== globalThis.fetch
      ? input.transport
      : null;
    response = customTransport
      ? await raceWithAbort(
          customTransport(targetUrl.toString(), {
            method: "GET",
            redirect: "error",
            signal,
            headers: { accept: "application/json" },
          }),
          signal,
        )
      : await sendPinnedHttpsGet(targetUrl, addresses, signal);
  } catch (error) {
    if (error instanceof Blocked) throw error;
    throw new Blocked("BUSINESS_TOOL_FAILED");
  }

  if (
    response.redirected ||
    response.type === "opaqueredirect" ||
    response.status < 200 ||
    response.status >= 300 ||
    isBodylessSuccessStatus(response.status)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Blocked("BUSINESS_TOOL_FAILED");
  }

  const payload = await readBoundedToolJson(response, signal);
  return {
    toolId,
    status: response.status,
    data: redactPayload(payload),
    redacted: true,
  };
}
