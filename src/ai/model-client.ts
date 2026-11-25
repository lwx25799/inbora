import { generateText, isStepCount } from "ai";
import {
  isValidModelId, modelRouteSnapshotSchema,
  type ConnectionRevision, type ModelProtocol, type ModelResult, type ModelRouteSnapshot, type ModelUsageDetails,
} from "./model-contracts.js";
import { createModelTransport, ModelError, requireModelKey, withModelDeadline, type ModelFetchOptions } from "./model-transport.js";
import { createModelProvider } from "./provider-factory.js";
import { endpointDigest, normalizeBaseUrl, previewGenerationUrl } from "./provider-presets.js";

export interface ModelTextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelGenerationInput extends ModelFetchOptions {
  revision: Readonly<ConnectionRevision>;
  snapshot: Readonly<ModelRouteSnapshot>;
  apiKey?: string | null | undefined;
  messages?: readonly ModelTextMessage[];
  beforeRequest?: () => void;
  onTelemetry?: (telemetry: ModelResponseTelemetry) => void;
}

export type ModelResponseTelemetry = Pick<ModelResult, "usage" | "reportedModelId">;

export function makeProviderTestMessages(): ModelTextMessage[] {
  return [{ role: "user", content: "Reply only with OK." }];
}

function readTextMessages(messages: ModelGenerationInput["messages"]): ModelTextMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) throw new ModelError("MODEL_REQUEST_UNSUPPORTED");
  return messages.map(message => {
    const { role, content } = message ?? {};
    if ((role !== "user" && role !== "assistant" && role !== "system") || typeof content !== "string") {
      throw new ModelError("MODEL_REQUEST_UNSUPPORTED");
    }
    return { role, content };
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sumReported(base: unknown, ...components: unknown[]): number | null {
  const first = count(base);
  const rest = components.map(value => value == null ? 0 : count(value));
  if (first === null || rest.some(value => value === null)) return null;
  return count(rest.reduce<number>((total, value) => total + (value ?? 0), first));
}

// Read the reported fields before SDK defaults can turn missing counts into zero
// or infer a total. Anthropic's input and Gemini's output have disjoint components.
function readUsage({ protocol, presetId }: ModelRouteSnapshot, body: Record<string, unknown>): ModelUsageDetails {
  const usage = record(body.usage);
  switch (protocol) {
    case "OPENAI_CHAT": {
      const promptDetails = record(usage.prompt_tokens_details);
      const cacheRead = presetId === "deepseek"
        ? usage.prompt_cache_hit_tokens ?? promptDetails.cached_tokens
        : promptDetails.cached_tokens ?? usage.prompt_cache_hit_tokens;
      return {
        inputTokens: count(usage.prompt_tokens),
        outputTokens: count(usage.completion_tokens),
        totalTokens: count(usage.total_tokens),
        reasoningTokens: count(record(usage.completion_tokens_details).reasoning_tokens),
        cacheReadTokens: count(cacheRead),
        cacheWriteTokens: count(promptDetails.cache_write_tokens),
      };
    }
    case "OPENAI_RESPONSES":
      return {
        inputTokens: count(usage.input_tokens),
        outputTokens: count(usage.output_tokens),
        totalTokens: count(usage.total_tokens),
        reasoningTokens: count(record(usage.output_tokens_details).reasoning_tokens),
        cacheReadTokens: count(record(usage.input_tokens_details).cached_tokens),
        cacheWriteTokens: count(record(usage.input_tokens_details).cache_write_tokens),
      };
    case "ANTHROPIC_MESSAGES":
      return {
        inputTokens: sumReported(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens),
        outputTokens: count(usage.output_tokens),
        totalTokens: count(usage.total_tokens),
        reasoningTokens: count(record(usage.output_tokens_details).thinking_tokens),
        cacheReadTokens: count(usage.cache_read_input_tokens),
        cacheWriteTokens: count(usage.cache_creation_input_tokens),
      };
    case "GEMINI_GENERATE_CONTENT": {
      const metadata = record(body.usageMetadata);
      return {
        inputTokens: sumReported(metadata.promptTokenCount, metadata.toolUsePromptTokenCount),
        outputTokens: sumReported(metadata.candidatesTokenCount, metadata.thoughtsTokenCount),
        totalTokens: count(metadata.totalTokenCount),
        reasoningTokens: count(metadata.thoughtsTokenCount),
        cacheReadTokens: count(metadata.cachedContentTokenCount),
        cacheWriteTokens: null,
      };
    }
  }
}

function assertAssistantOutput(protocol: Exclude<ModelProtocol, "OPENAI_RESPONSES">, body: Record<string, unknown>): void {
  const candidates = protocol === "OPENAI_CHAT" ? body.choices : body.candidates;
  const candidate = record(Array.isArray(candidates) ? candidates[0] : undefined);
  if (protocol === "ANTHROPIC_MESSAGES" && body.stop_reason === "pause_turn") {
    throw new ModelError("MODEL_OUTPUT_INCOMPLETE");
  }
  const role = protocol === "ANTHROPIC_MESSAGES" ? body.role
    : record(protocol === "OPENAI_CHAT" ? candidate.message : candidate.content).role;
  const expectedRole = protocol === "GEMINI_GENERATE_CONTENT" ? "model" : "assistant";
  if (role != null && role !== expectedRole) throw new ModelError("MODEL_RESPONSE_INVALID");
}

function readResponsesText(body: Record<string, unknown>, sdkText: string): string {
  const messages = (Array.isArray(body.output) ? body.output : []).map(record).filter(item => item.type === "message");
  const phased = messages.some(item => item.phase != null);
  const answers = phased ? messages.filter(item => item.phase === "final_answer") : messages;
  const incomplete = body.status === "incomplete" || body.status === "in_progress" || body.status === "queued"
    || body.status === "cancelled" || answers.some(item => item.status === "incomplete" || item.status === "in_progress");
  if (incomplete) throw new ModelError("MODEL_OUTPUT_INCOMPLETE");
  if (body.status === "failed" || messages.some(({ role }) => role != null && role !== "assistant")) {
    throw new ModelError("MODEL_RESPONSE_INVALID");
  }
  if (!phased) return sdkText;

  // The SDK also includes commentary in result.text. Validate each answer from the wire items.
  return answers.map(item => {
    if (item.status !== "completed" || !Array.isArray(item.content)) throw new ModelError("MODEL_OUTPUT_INCOMPLETE");
    const text = item.content.map(record).map(part =>
      part.type === "output_text" && typeof part.text === "string" ? part.text : "").join("");
    if (!text.trim()) throw new ModelError("MODEL_OUTPUT_INCOMPLETE");
    return text;
  }).join("");
}

export async function generateModelText(input: ModelGenerationInput): Promise<ModelResult> {
  const { revision } = input;
  const apiKey = requireModelKey(input.apiKey);
  const credential = apiKey.trim();
  const baseUrl = normalizeBaseUrl(revision.baseUrl);
  const parsed = modelRouteSnapshotSchema.safeParse(input.snapshot);
  if (!parsed.success) throw new ModelError("MODEL_ROUTE_CHANGED");
  const snapshot = parsed.data;
  if (snapshot.endpointDigest !== endpointDigest(baseUrl) || snapshot.protocol !== revision.protocol ||
      snapshot.presetId !== revision.presetId || snapshot.connectionId !== revision.connectionId ||
      snapshot.routeRevision !== revision.routeRevision || snapshot.credentialRevision !== revision.credentialRevision) {
    throw new ModelError("MODEL_ROUTE_CHANGED");
  }

  const { modelId, protocol, purpose } = snapshot;
  const messages = purpose === "PROVIDER_TEST" ? makeProviderTestMessages() : readTextMessages(input.messages);
  const url = previewGenerationUrl(baseUrl, protocol, modelId);
  return withModelDeadline("generation", input.signal, async signal => {
    const transport = createModelTransport(url, "POST", signal, input.transport, input.beforeRequest, input.lookup);
    try {
      const { model, providerOptions } = createModelProvider(snapshot, baseUrl, apiKey, transport.fetch);
      const result = await generateText({
        model, messages, providerOptions, abortSignal: signal, allowSystemInMessages: true,
        maxOutputTokens: purpose === "PERSONA_ANALYSIS" || purpose === "PERSONA_MERGE" ? 2048 : 512,
        maxRetries: 0,
        experimental_telemetry: { isEnabled: false },
        stopWhen: isStepCount(1),
        include: { responseBody: true },
      });
      if (transport.failure) throw transport.failure;
      const body = record(result.response.body);
      const reported = protocol === "GEMINI_GENERATE_CONTENT" ? body.modelVersion : body.model;
      const telemetry = {
        reportedModelId: isValidModelId(reported) && !reported.includes(credential) ? reported : null,
        usage: readUsage(snapshot, body),
      };
      input.onTelemetry?.(telemetry);
      signal.throwIfAborted();
      const { finishReason } = result;
      const text = protocol === "OPENAI_RESPONSES" ? readResponsesText(body, result.text) : result.text;
      if (!text.trim() || finishReason !== "stop" || result.toolCalls.length > 0) {
        throw new ModelError("MODEL_OUTPUT_INCOMPLETE");
      }
      if (protocol !== "OPENAI_RESPONSES") assertAssistantOutput(protocol, body);
      if (text.includes(credential)) throw new ModelError("MODEL_RESPONSE_INVALID");
      return {
        text, finishReason, requestedModelId: modelId,
        ...telemetry,
      };
    } catch (error) {
      signal.throwIfAborted();
      if (transport.failure) throw transport.failure;
      if (error instanceof ModelError) throw error;
      throw new ModelError("MODEL_RESPONSE_INVALID");
    }
  });
}
