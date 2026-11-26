import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { generateText, LanguageModel } from "ai";
import type { ModelRouteSnapshot } from "./model-contracts.js";
import { ModelError, requireModelKey } from "./model-transport.js";
import { isOfficialOpenRouterEndpoint, isOpenRouterRoutingModel, normalizeBaseUrl, previewGenerationUrl } from "./provider-presets.js";

export function validateModelProvider(route: Pick<ModelRouteSnapshot, "presetId" | "protocol" | "modelId">, baseUrl: string) {
  const baseURL = normalizeBaseUrl(baseUrl);
  const isOpenRouter = route.presetId === "openrouter" || isOfficialOpenRouterEndpoint(baseURL);
  if ((route.presetId === "deepseek" || isOpenRouter) && route.protocol !== "OPENAI_CHAT") {
    throw new ModelError("MODEL_PROTOCOL_UNSUPPORTED");
  }
  if (isOpenRouter && (route.presetId === "deepseek" || isOpenRouterRoutingModel(route.modelId))) {
    throw new ModelError("MODEL_REQUEST_UNSUPPORTED");
  }
  previewGenerationUrl(baseURL, route.protocol, route.modelId);
  return { baseURL, isOpenRouter };
}

export function createModelProvider(
  route: Pick<ModelRouteSnapshot, "presetId" | "protocol" | "modelId">,
  baseUrl: string,
  apiKey: string | null | undefined,
  fetch: typeof globalThis.fetch,
): { model: LanguageModel; providerOptions: NonNullable<Parameters<typeof generateText>[0]["providerOptions"]> } {
  const { baseURL, isOpenRouter } = validateModelProvider(route, baseUrl);
  const options = { baseURL, apiKey: requireModelKey(apiKey), fetch };
  const { modelId, presetId, protocol } = route;

  switch (protocol) {
    case "OPENAI_RESPONSES":
      return { model: createOpenAI(options).responses(modelId), providerOptions: { openai: { store: false } } };
    case "ANTHROPIC_MESSAGES":
      return { model: createAnthropic(options)(modelId), providerOptions: {} };
    case "GEMINI_GENERATE_CONTENT":
      // The SDK adds the resource prefix and uses the bare ID to detect model capabilities.
      return { model: createGoogleGenerativeAI(options)(encodeURIComponent(modelId)), providerOptions: {} };
    case "OPENAI_CHAT": {
      if (presetId === "deepseek") {
        return {
          model: createDeepSeek(options).chat(modelId),
          providerOptions: { deepseek: { thinking: { type: "disabled" } } },
        };
      }
      if (presetId === "openai" && !isOpenRouter) {
        return { model: createOpenAI(options).chat(modelId), providerOptions: {} };
      }
      const compatibleOptions = isOpenRouter ? {
        ...options,
        transformRequestBody: (body: Record<string, unknown>) => ({ ...body, provider: { allow_fallbacks: false } }),
      } : options;
      return {
        model: createOpenAICompatible({ ...compatibleOptions, name: isOpenRouter ? "openrouter" : presetId }).chatModel(modelId),
        providerOptions: {},
      };
    }
    default: throw new ModelError("MODEL_PROTOCOL_UNSUPPORTED");
  }
}
