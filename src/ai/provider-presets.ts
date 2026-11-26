import { isIP } from "node:net";
import { digest } from "../core/contracts.js";
import {
  modelBaseUrlSchema, modelIdSchema, type ModelPresetId, type ModelProtocol,
} from "./model-contracts.js";
import { isPublicModelAddress, ModelError } from "./model-transport.js";

export interface ModelProviderPreset {
  readonly name: string;
  readonly protocol: ModelProtocol | null;
  readonly baseUrl: string | null;
  readonly supportsCatalog: boolean;
  readonly regions: readonly { readonly id: string; readonly name: string; readonly baseUrl: string }[];
  readonly modelIdKinds?: readonly ("MODEL_ID" | "ENDPOINT_ID")[];
}

const qwenRegions = [
  { id: "beijing", name: "北京", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "singapore", name: "新加坡", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { id: "us", name: "美国", baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1" },
] as const;
const siliconflowRegions = [
  { id: "china", name: "中国站", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "international", name: "国际站", baseUrl: "https://api.siliconflow.com/v1" },
] as const;
const doubaoRegions = [
  { id: "beijing", name: "北京", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
] as const;

export const MODEL_PROVIDER_PRESETS: Readonly<Record<ModelPresetId, ModelProviderPreset>> = {
  deepseek: {
    name: "DeepSeek", protocol: "OPENAI_CHAT", baseUrl: "https://api.deepseek.com", supportsCatalog: true, regions: [],
  },
  openai: {
    name: "OpenAI", protocol: "OPENAI_RESPONSES", baseUrl: "https://api.openai.com/v1", supportsCatalog: true, regions: [],
  },
  anthropic: {
    name: "Claude", protocol: "ANTHROPIC_MESSAGES", baseUrl: "https://api.anthropic.com/v1", supportsCatalog: true, regions: [],
  },
  gemini: {
    name: "Gemini", protocol: "GEMINI_GENERATE_CONTENT", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    supportsCatalog: true, regions: [],
  },
  qwen: {
    name: "通义千问", protocol: "OPENAI_CHAT", baseUrl: qwenRegions[0].baseUrl, supportsCatalog: false, regions: qwenRegions,
  },
  doubao: {
    name: "豆包", protocol: "OPENAI_CHAT", baseUrl: doubaoRegions[0].baseUrl, supportsCatalog: false, regions: doubaoRegions,
    modelIdKinds: ["MODEL_ID", "ENDPOINT_ID"],
  },
  siliconflow: {
    name: "硅基流动", protocol: "OPENAI_CHAT", baseUrl: siliconflowRegions[0].baseUrl, supportsCatalog: true,
    regions: siliconflowRegions,
  },
  openrouter: {
    name: "OpenRouter", protocol: "OPENAI_CHAT", baseUrl: "https://openrouter.ai/api/v1", supportsCatalog: true, regions: [],
  },
  custom: { name: "自定义", protocol: null, baseUrl: null, supportsCatalog: true, regions: [] },
};

const operationPath = /\/(?:chat\/completions|responses|messages|models)$|:generateContent$/iu;
const repeatedVersion = /\/(v\d+(?:alpha|beta)?\d*)\/\1(?:\/|$)/iu;

function invalidBaseUrl(message = "请填写不含凭据、查询、片段或歧义路径的公网 HTTPS Base URL。"): never {
  throw new ModelError("MODEL_REQUEST_UNSUPPORTED", undefined, message);
}

export function normalizeBaseUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2048) return invalidBaseUrl();
  const path = /^https:\/\/[^/?#]*(\/[^?#]*)?/iu.exec(value)?.[1] ?? "";
  let decodedPath: string;
  try {
    decodedPath = path.split("/").map(segment => {
      const decoded = decodeURIComponent(segment);
      if (decoded === "." || decoded === ".." || /[\/\\?#\p{Cc}]/u.test(decoded)) return invalidBaseUrl();
      return decoded;
    }).join("/").replace(/\/+$/u, "");
  } catch {
    return invalidBaseUrl();
  }
  if (operationPath.test(decodedPath)) {
    return invalidBaseUrl("请填写 HTTPS Base URL，移除末尾的生成或模型列表接口路径。");
  }
  if (repeatedVersion.test(decodedPath) || !modelBaseUrlSchema.safeParse(value).success) return invalidBaseUrl();

  const url = new URL(value);
  const host = url.hostname.replace(/\.+$/u, "").replace(/^\[|\]$/gu, "");
  if (/(?:^|\.)(?:localhost|local|internal|home\.arpa)$/u.test(host)) return invalidBaseUrl();
  if (isIP(host) && !isPublicModelAddress(host)) return invalidBaseUrl();
  return url.origin + url.pathname.replace(/\/$/u, "");
}

export function endpointDigest(baseUrl: string): string {
  return digest(normalizeBaseUrl(baseUrl));
}

export function isOpenRouterRoutingModel(modelId: unknown): boolean {
  return typeof modelId === "string" && /^openrouter\/(?:auto|free)(?::|$)/iu.test(modelId);
}

export function isOfficialOpenRouterEndpoint(baseUrl: string): boolean {
  return new URL(baseUrl).hostname.replace(/\.+$/u, "") === "openrouter.ai";
}

export function previewGenerationUrl(baseUrl: string, protocol: ModelProtocol, modelId: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!modelIdSchema.safeParse(modelId).success) throw new ModelError("MODEL_REQUEST_UNSUPPORTED");
  switch (protocol) {
    case "OPENAI_CHAT": return base + "/chat/completions";
    case "OPENAI_RESPONSES": return base + "/responses";
    case "ANTHROPIC_MESSAGES": return base + "/messages";
    case "GEMINI_GENERATE_CONTENT": return base + "/models/" + encodeURIComponent(modelId) + ":generateContent";
    default: throw new ModelError("MODEL_PROTOCOL_UNSUPPORTED");
  }
}
