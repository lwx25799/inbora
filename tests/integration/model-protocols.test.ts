import { afterEach, expect, test, vi } from "vitest";
import { generateModelText, makeProviderTestMessages, type ModelGenerationInput } from "../../src/ai/model-client.js";
import type { ModelCallPurpose, ModelPresetId, ModelProtocol } from "../../src/ai/model-contracts.js";
import { endpointDigest, MODEL_PROVIDER_PRESETS } from "../../src/ai/provider-presets.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const credentialRevision = "00000000-0000-4000-8000-000000000002";
const commandId = "00000000-0000-4000-8000-000000000003";

function generationInput(
  transport: typeof fetch,
  presetId: ModelPresetId = "custom",
  protocol: ModelProtocol = "OPENAI_CHAT",
  modelId = "Vendor/Model:free",
  purpose: ModelCallPurpose = "REPLY_GENERATION",
): ModelGenerationInput {
  const baseUrl = MODEL_PROVIDER_PRESETS[presetId].baseUrl ?? "https://models.example.com/workspace/v1";
  const route = { connectionId, routeRevision: 1, presetId, protocol, credentialRevision };
  const shared = { ...route, endpointDigest: endpointDigest(baseUrl), modelId };
  return {
    revision: { ...route, baseUrl, region: null, storage: "MEMORY", createdAt: 0 },
    snapshot: purpose === "PROVIDER_TEST"
      ? { ...shared, purpose, selectionRevision: null, grantVersion: null, commandId, testVersion: 1 }
      : { ...shared, purpose, selectionRevision: 1, grantVersion: 1 },
    apiKey: "synthetic-generation-key",
    messages: [{ role: "user", content: "Synthetic content only." }],
    transport,
  };
}

function chatResponse(content: string | null = "Reply", finish = "stop", model?: string) {
  return {
    id: "chat-response", created: 0, model,
    choices: [{ index: 0, message: { role: "assistant", content, reasoning_content: "Hidden reasoning" }, finish_reason: finish }],
  };
}

afterEach(() => vi.unstubAllEnvs());

test.each([
  ["custom", "https://models.example.com/workspace/v1/chat/completions"],
  ["deepseek", "https://api.deepseek.com/chat/completions"],
  ["openai", "https://api.openai.com/v1/chat/completions"],
  ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
] as const)("%s chat sends the exact model and only its own provider-specific options", async (presetId, expectedUrl) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    ...chatResponse("Reply", "stop", "vendor/reported:2026"),
    usage: {
      prompt_tokens: 20, completion_tokens: 8, total_tokens: 29,
      ...(presetId === "deepseek" && { prompt_cache_hit_tokens: 12 }),
      prompt_tokens_details: { cached_tokens: presetId === "deepseek" ? 0 : 12 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  }));
  const result = await generateModelText(generationInput(transport, presetId));
  expect(result).toEqual({
    text: "Reply", requestedModelId: "Vendor/Model:free", reportedModelId: "vendor/reported:2026", finishReason: "stop",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 29, cacheReadTokens: 12, cacheWriteTokens: null, reasoningTokens: 5 },
  });
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, init] = transport.mock.calls[0]!;
  const body = JSON.parse(String(init?.body));
  expect(String(url)).toBe(expectedUrl);
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-generation-key");
  expect(body.model).toBe("Vendor/Model:free");
  expect(body.max_tokens ?? body.max_completion_tokens).toBe(512);
  expect(body.stream).not.toBe(true);
  expect(body).not.toHaveProperty("tools");
  expect(body).not.toHaveProperty("models");
  expect(body.thinking).toEqual(presetId === "deepseek" ? { type: "disabled" } : undefined);
  expect(body.provider).toEqual(presetId === "openrouter" ? { allow_fallbacks: false } : undefined);
});

test("Responses disables storage and preserves only final text and reported usage", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    id: "resp_example", created_at: 0, model: "gpt-4.1-2025-04-14", status: "completed",
    output: [
      { type: "reasoning", id: "rs_example", summary: [{ type: "summary_text", text: "Hidden" }] },
      { type: "message", id: "msg_example", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Final text", annotations: [] }] },
    ],
    usage: {
      input_tokens: 23, output_tokens: 12, total_tokens: 36,
      input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 8 },
    },
  }));
  const result = await generateModelText(generationInput(transport, "openai", "OPENAI_RESPONSES", "gpt-4.1", "PERSONA_MERGE"));
  expect(result).toMatchObject({
    text: "Final text", requestedModelId: "gpt-4.1", reportedModelId: "gpt-4.1-2025-04-14",
    usage: { inputTokens: 23, outputTokens: 12, totalTokens: 36, reasoningTokens: 8, cacheReadTokens: 7 },
  });
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, init] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://api.openai.com/v1/responses");
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-4.1", store: false, max_output_tokens: 2048 });
});

test.each([
  [[], null],
  [[{ phase: "final_answer", status: "completed", text: "Final answer" }], "Final answer"],
  [[{ phase: "final_answer", status: "in_progress", text: "Partial answer" }], null],
  [[{ phase: "final_answer", status: "completed", text: "First section" },
    { phase: "final_answer", status: "incomplete", text: "Partial second section" }], null],
  [[{ phase: "final_answer", status: "completed", text: "First section" },
    { phase: "final_answer", status: undefined, text: "No status" }], null],
  [[{ phase: "final_answer", status: "completed", text: "First section" },
    { phase: "final_answer", status: "queued", text: "Still queued" }], null],
  [[{ phase: "final_answer", status: "completed", text: "First section" },
    { phase: "final_answer", status: "completed", text: " \n " }], null],
  [[{ phase: "final_answer", status: "completed", text: "First section" },
    { phase: "final_answer", status: "completed", text: " and second section" }], "First section and second section"],
] as const)("Responses exposes only completed final_answer text with phase markers (%j)", async (answers, expected) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    id: "resp_phases", created_at: 0, model: "gpt-4.1", status: "completed",
    output: [{ phase: "commentary", status: "completed", text: "Process narration" }, ...answers].map((part, index) => ({
      type: "message", id: `msg_${index}`, role: "assistant", phase: part.phase, status: part.status,
      content: [{ type: "output_text", text: part.text, annotations: [] }],
    })),
  }));
  const result = generateModelText(generationInput(transport, "openai", "OPENAI_RESPONSES", "gpt-4.1"));
  if (expected !== null) expect((await result).text).toBe(expected);
  else await expect(result).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
  expect(transport).toHaveBeenCalledOnce();
});

test("Responses rejects an explicitly unfinished message even without a phase marker", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    id: "resp_unphased", created_at: 0, model: "gpt-4.1", status: "completed",
    output: [{ type: "message", id: "msg_partial", role: "assistant", status: "in_progress",
      content: [{ type: "output_text", text: "Partial answer", annotations: [] }] }],
  }));
  await expect(generateModelText(generationInput(transport, "openai", "OPENAI_RESPONSES", "gpt-4.1")))
    .rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
});

test("Anthropic Messages retains the snapshot name and counts each cache component once", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    id: "msg_example", type: "message", role: "assistant", model: "claude-snapshot",
    content: [{ type: "thinking", thinking: "Hidden", signature: "synthetic" }, { type: "text", text: "Final" }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
  }));
  const result = await generateModelText(generationInput(transport, "anthropic", "ANTHROPIC_MESSAGES", "claude-alias", "PERSONA_ANALYSIS"));
  expect(result).toMatchObject({
    text: "Final", requestedModelId: "claude-alias", reportedModelId: "claude-snapshot",
    usage: { inputTokens: 16, outputTokens: 8, totalTokens: null, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: null },
  });
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, init] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
  expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-generation-key");
  expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-alias", max_tokens: 2048 });
});

test("Gemini uses a header Key and counts thoughts once in the SDK output total", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    modelVersion: "gemini-snapshot",
    candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Hidden", thought: true }, { text: "Final" }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, thoughtsTokenCount: 3, cachedContentTokenCount: 5, totalTokenCount: 22 },
  }));
  const result = await generateModelText(generationInput(transport, "gemini", "GEMINI_GENERATE_CONTENT", "gemini-alias"));
  expect(result).toMatchObject({
    text: "Final", requestedModelId: "gemini-alias", reportedModelId: "gemini-snapshot",
    usage: { inputTokens: 12, outputTokens: 10, totalTokens: 22, cacheReadTokens: 5, reasoningTokens: 3 },
  });
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, init] = transport.mock.calls[0]!;
  expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-alias:generateContent");
  expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("synthetic-generation-key");
  expect(JSON.parse(String(init?.body))).toMatchObject({ generationConfig: { maxOutputTokens: 512 } });
});

test("Gemma retains native capability detection when using the Gemini protocol", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Final" }] } }],
  }));
  const call = generationInput(transport, "gemini", "GEMINI_GENERATE_CONTENT", "gemma-3-27b-it");
  await generateModelText({ ...call, messages: [{ role: "system", content: "Synthetic instruction" }, ...call.messages!] });
  const [url, init] = transport.mock.calls[0]!;
  const body = JSON.parse(String(init?.body));
  expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent");
  expect(body).not.toHaveProperty("systemInstruction");
  expect(body.contents[0]).toEqual({
    role: "user", parts: [{ text: "Synthetic instruction\n\n" }, { text: "Synthetic content only." }],
  });
});

test("connection tests always use the fixed message and accept a valid answer besides OK", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(chatResponse("Connection works")));
  const result = await generateModelText(generationInput(transport, "custom", "OPENAI_CHAT", "model", "PROVIDER_TEST"));
  expect(result.text).toBe("Connection works");
  expect(result.reportedModelId).toBeNull();
  expect(result.usage).toEqual({
    inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
  });
  const body = JSON.parse(String(transport.mock.calls[0]![1]?.body));
  expect(body.messages).toEqual(makeProviderTestMessages());
  expect(body.messages[0].content).toMatch(/OK/u);
});

test("business generation sends text instructions and user turns through the selected protocol", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(chatResponse()));
  const messages = [
    { role: "system", content: "Synthetic instruction" },
    { role: "user", content: "Synthetic input" },
  ] as const;
  expect((await generateModelText({ ...generationInput(transport), messages })).text).toBe("Reply");
  expect(JSON.parse(String(transport.mock.calls[0]![1]?.body)).messages).toEqual(messages);
});

test("invalid usage counts become null without changing valid counts", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    ...chatResponse(),
    usage: {
      prompt_tokens: -1, completion_tokens: 7, total_tokens: Number.MAX_SAFE_INTEGER + 1,
      completion_tokens_details: { reasoning_tokens: 1.5 },
    },
  }));
  expect((await generateModelText(generationInput(transport))).usage).toMatchObject({
    inputTokens: null, outputTokens: 7, totalTokens: null, reasoningTokens: null,
  });
});

test("provider-controlled fields cannot echo the active Key into a normalized result", async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(chatResponse("Final", "stop", "model-synthetic-generation-key")))
    .mockResolvedValueOnce(Response.json(chatResponse("Bearer synthetic-generation-key")));
  const call = generationInput(transport);
  expect((await generateModelText(call)).reportedModelId).toBeNull();
  await expect(generateModelText(call)).rejects.toMatchObject({
    code: "MODEL_RESPONSE_INVALID", message: "MODEL_RESPONSE_INVALID",
  });
});

test.each([
  ["", "stop"], [null, "stop"], ["Cut off", "length"], ["Filtered", "content_filter"],
  ["Incomplete", "tool_calls"], ["Partial", "vendor_specific_unfinished"],
])("rejects incomplete chat content %j / %s", async (content, finish) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(chatResponse(content, finish)));
  await expect(generateModelText(generationInput(transport))).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
  expect(transport).toHaveBeenCalledTimes(1);
});

test("Anthropic pause_turn remains incomplete even when the SDK maps it to stop", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    id: "msg_paused", type: "message", role: "assistant", model: "claude-alias",
    content: [{ type: "text", text: "Partial" }], stop_reason: "pause_turn", stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 5 },
  }));
  await expect(generateModelText(generationInput(transport, "anthropic", "ANTHROPIC_MESSAGES", "claude-alias")))
    .rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each([
  ["openai", "OPENAI_RESPONSES", "OPENAI_API_KEY"], ["anthropic", "ANTHROPIC_MESSAGES", "ANTHROPIC_API_KEY"],
  ["deepseek", "OPENAI_CHAT", "DEEPSEEK_API_KEY"], ["gemini", "GEMINI_GENERATE_CONTENT", "GOOGLE_GENERATIVE_AI_API_KEY"],
] as const)("%s refuses absent or blank connection Keys despite a host environment Key", async (preset, protocol, env) => {
  vi.stubEnv(env, "synthetic-ambient-key");
  vi.stubEnv("GEMINI_API_KEY", "synthetic-ambient-key");
  const transport = vi.fn<typeof fetch>();
  for (const apiKey of [undefined, "", " \t "]) {
    await expect(generateModelText({ ...generationInput(transport, preset, protocol), apiKey }))
      .rejects.toMatchObject({ code: "MODEL_KEY_REQUIRED" });
  }
  expect(transport).not.toHaveBeenCalled();
});

test("Gemini SDK continuation cannot issue a second POST", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    candidates: [{ finishReason: "CONTINUATION", continuationToken: "vendor-token",
      content: { role: "model", parts: [{ text: "Partial" }] } }],
  }));
  await expect(generateModelText(generationInput(transport, "gemini", "GEMINI_GENERATE_CONTENT", "gemini-alias")))
    .rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
  expect(transport).toHaveBeenCalledTimes(1);
});

test.each(["openrouter/auto", "openrouter/free"])("OpenRouter rejects the routing alias %s before a paid request", async modelId => {
  const transport = vi.fn<typeof fetch>();
  await expect(generateModelText(generationInput(transport, "openrouter", "OPENAI_CHAT", modelId)))
    .rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
  expect(transport).not.toHaveBeenCalled();
});

test("the official OpenRouter endpoint keeps fallback disabled under a custom connection", async () => {
  const baseUrl = "https://openrouter.ai/api/v1";
  const transport = vi.fn<typeof fetch>(async () => Response.json(chatResponse()));
  const call = generationInput(transport);
  const revision = { ...call.revision, baseUrl };
  const snapshot = { ...call.snapshot, endpointDigest: endpointDigest(baseUrl) };
  await generateModelText({ ...call, revision, snapshot });
  const payload = JSON.parse(String(transport.mock.calls[0]![1]?.body));
  expect(payload.provider).toEqual({ allow_fallbacks: false });
  expect(payload).not.toHaveProperty("models");
  await expect(generateModelText({ ...call, revision, snapshot: { ...snapshot, modelId: "openrouter/free" } }))
    .rejects.toMatchObject({ code: "MODEL_REQUEST_UNSUPPORTED" });
  expect(transport).toHaveBeenCalledOnce();
});

test.each(["deepseek", "openrouter"] as const)("%s cannot bypass its required request options by changing protocols", async preset => {
  const transport = vi.fn<typeof fetch>();
  await expect(generateModelText(generationInput(transport, preset, "OPENAI_RESPONSES")))
    .rejects.toMatchObject({ code: "MODEL_PROTOCOL_UNSUPPORTED" });
  expect(transport).not.toHaveBeenCalled();
});
