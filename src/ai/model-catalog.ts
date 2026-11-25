import { Blocked } from "../core/contracts.js";
import {
  modelCatalogEntrySchema, modelErrorCodeSchema, modelProtocolSchema, type ConnectionRevision, type ModelCatalogEntry,
  type ModelCatalogResult, type ModelProtocol,
} from "./model-contracts.js";
import { createModelTransport, ModelError, requireModelKey, withModelDeadline, type ModelFetchOptions } from "./model-transport.js";
import { isOfficialOpenRouterEndpoint, isOpenRouterRoutingModel, MODEL_PROVIDER_PRESETS, normalizeBaseUrl } from "./provider-presets.js";

const MAX_PAGES = 5;
const MAX_MODELS = 2000;

export interface ModelCatalogInput extends ModelFetchOptions {
  revision: Readonly<ConnectionRevision>;
  apiKey?: string | null | undefined;
  beforeRequest?: () => void;
}

export interface DiscoveredModelCatalog {
  catalog: ModelCatalogResult;
  truncated: boolean;
}

export function catalogReachedLimit({ status, reason }: Pick<ModelCatalogResult, "status" | "reason">): boolean {
  return status === "PARTIAL" && (reason === null || reason === "MODEL_RESPONSE_TOO_LARGE");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPage(value: unknown, protocol: ModelProtocol): { rows: unknown[]; cursor: string | null } {
  const page = record(value);
  const rows = protocol === "GEMINI_GENERATE_CONTENT" ? page.models : page.data;
  if (!Array.isArray(rows)) throw new ModelError("MODEL_RESPONSE_INVALID");
  let cursor: unknown = null;
  if (protocol === "ANTHROPIC_MESSAGES") {
    if (page.has_more != null && typeof page.has_more !== "boolean") throw new ModelError("MODEL_RESPONSE_INVALID");
    if (page.has_more) {
      cursor = page.last_id;
      if (typeof cursor !== "string" || !cursor) throw new ModelError("MODEL_RESPONSE_INVALID");
    }
  }
  if (protocol === "GEMINI_GENERATE_CONTENT" && page.nextPageToken !== "") cursor = page.nextPageToken ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 2048 || /\p{Cc}/u.test(cursor))) {
    throw new ModelError("MODEL_RESPONSE_INVALID");
  }
  return { rows, cursor };
}

function readEntry(row: unknown, protocol: ModelProtocol, filterOpenRouter: boolean, credential: string): ModelCatalogEntry | null {
  const model = record(row);
  let modelId = model.id;
  let name = model.display_name ?? model.name;
  if (protocol === "GEMINI_GENERATE_CONTENT") {
    if (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes("generateContent")) {
      return null;
    }
    if (typeof model.name !== "string" || !model.name.startsWith("models/")) return null;
    const geminiId = model.name.slice("models/".length);
    modelId = geminiId;
    name = model.displayName;
    const modalities = model.outputModalities;
    if (Array.isArray(modalities) && !modalities.includes("TEXT")) return null;
    if (!Array.isArray(modalities) && /^gemini-.*-(?:tts|native-audio|image|computer-use)(?:-|$)/u.test(geminiId)) return null;
  } else if (filterOpenRouter) {
    const modalities = record(model.architecture).output_modalities;
    if (!Array.isArray(modalities) || !modalities.includes("text") || isOpenRouterRoutingModel(modelId)) return null;
  }
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 256 || modelId.includes(credential)) return null;
  const displayName = typeof name === "string" && name.trim() && name.length <= 200 && !name.includes(credential) ? name : null;
  const entry = modelCatalogEntrySchema.safeParse({ modelId, source: "DISCOVERED", displayName });
  return entry.success ? entry.data : null;
}

function catalogHeaders(protocol: ModelProtocol, key: string): HeadersInit {
  switch (protocol) {
    case "ANTHROPIC_MESSAGES": return { "x-api-key": key, "anthropic-version": "2023-06-01" };
    case "GEMINI_GENERATE_CONTENT": return { "x-goog-api-key": key };
    default: return { authorization: `Bearer ${key}` };
  }
}

export async function discoverModelCatalog(input: ModelCatalogInput): Promise<DiscoveredModelCatalog> {
  const { connectionId, routeRevision, protocol, presetId } = input.revision;
  const models = new Map<string, ModelCatalogEntry>();
  let fetchedAt: number | null = null;
  const result = (status: ModelCatalogResult["status"], reason: ModelCatalogResult["reason"] = null): DiscoveredModelCatalog => ({
    catalog: { connectionId, routeRevision, status, reason, models: [...models.values()], fetchedAt },
    truncated: catalogReachedLimit({ status, reason }),
  });
  try {
    if (!modelProtocolSchema.safeParse(protocol).success) throw new ModelError("MODEL_PROTOCOL_UNSUPPORTED");
    if (!MODEL_PROVIDER_PRESETS[presetId]?.supportsCatalog) throw new ModelError("MODEL_REQUEST_UNSUPPORTED");
    const base = normalizeBaseUrl(input.revision.baseUrl);
    const key = requireModelKey(input.apiKey);
    const credential = key.trim();
    const endpoint = new URL(base + "/models");
    const headers = catalogHeaders(protocol, key);
    const isOpenRouter = presetId === "openrouter" || isOfficialOpenRouterEndpoint(base);
    if (presetId === "siliconflow" && base === MODEL_PROVIDER_PRESETS.siliconflow.baseUrl) {
      endpoint.searchParams.set("sub_type", "chat");
    }
    return await withModelDeadline("catalog", input.signal, async signal => {
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const url = endpoint.href;
        const wire = createModelTransport(url, "GET", signal, input.transport, input.beforeRequest, input.lookup);
        const response = await wire.fetch(url, { method: "GET", headers });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new ModelError("MODEL_RESPONSE_INVALID");
        }
        signal.throwIfAborted();
        const { rows, cursor } = readPage(body, protocol);
        fetchedAt = Date.now();
        for (const row of rows) {
          const entry = readEntry(row, protocol, isOpenRouter, credential);
          if (entry && !models.has(entry.modelId)) models.set(entry.modelId, entry);
          if (models.size === MAX_MODELS) return result("PARTIAL");
        }
        if (cursor === null) return result("COMPLETE");
        if (cursor.includes(credential) || seenCursors.has(cursor)) return result("PARTIAL", "MODEL_RESPONSE_INVALID");
        seenCursors.add(cursor);
        endpoint.searchParams.set(protocol === "ANTHROPIC_MESSAGES" ? "after_id" : "pageToken", cursor);
      }
      return result("PARTIAL");
    });
  } catch (error) {
    const reason = modelErrorCodeSchema.safeParse(error instanceof Blocked ? error.code : undefined);
    const code = reason.success ? reason.data : "MODEL_RESPONSE_INVALID";
    const partial = fetchedAt !== null || code === "MODEL_RESPONSE_TOO_LARGE" || code === "MODEL_TIMEOUT";
    return result(partial ? "PARTIAL" : "FAILED", code);
  }
}

export function mergeModelCatalog(
  previous: readonly ModelCatalogEntry[],
  refresh: { status: ModelCatalogResult["status"]; models: readonly ModelCatalogEntry[] },
  selectedModelId: string | null,
): { models: ModelCatalogEntry[]; selectedMissingFromCatalog: boolean } {
  if (refresh.status === "FAILED") {
    return { models: [...previous], selectedMissingFromCatalog: false };
  }
  const merged = new Map(previous.filter(entry => entry.source === "MANUAL").map(entry => [entry.modelId, entry]));
  const selected = refresh.models.find(entry => entry.modelId === selectedModelId);
  if (selectedModelId && !merged.has(selectedModelId)) {
    merged.set(selectedModelId, selected ?? previous.find(entry => entry.modelId === selectedModelId)
      ?? { modelId: selectedModelId, source: "DISCOVERED", displayName: null });
  }
  const carryover = refresh.status === "PARTIAL" ? previous : [];
  for (const entry of [...refresh.models, ...carryover]) {
    if (merged.size >= MAX_MODELS * 2) break;
    if (!merged.has(entry.modelId)) merged.set(entry.modelId, entry);
  }
  return {
    models: [...merged.values()],
    selectedMissingFromCatalog: selectedModelId !== null && !selected,
  };
}
