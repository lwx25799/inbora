import { expect, test, vi } from "vitest";
import { discoverModelCatalog, mergeModelCatalog } from "../../src/ai/model-catalog.js";
import { modelCatalogResultSchema, type ConnectionRevision, type ModelCatalogEntry } from "../../src/ai/model-contracts.js";

const revision: ConnectionRevision = {
  connectionId: "00000000-0000-4000-8000-000000000001", routeRevision: 1,
  presetId: "anthropic", protocol: "ANTHROPIC_MESSAGES", baseUrl: "https://api.anthropic.com/v1",
  region: null, credentialRevision: "00000000-0000-4000-8000-000000000002", storage: "MEMORY", createdAt: 0,
};
const read = (transport: typeof fetch, settings = revision) =>
  discoverModelCatalog({ revision: settings, apiKey: "synthetic-catalog-key", transport });
const entry = (modelId: string, source: ModelCatalogEntry["source"] = "DISCOVERED", displayName: string | null = null): ModelCatalogEntry =>
  ({ modelId, source, displayName });

test("Anthropic uses bounded cursor paging with the same endpoint and auth", async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-one", display_name: "Claude One" }], has_more: true, last_id: "next&cursor" }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-two" }, { id: "claude-one" }], has_more: false }));
  const result = await read(transport);
  expect(result).toMatchObject({
    truncated: false,
    catalog: { status: "COMPLETE", reason: null, models: [entry("claude-one", "DISCOVERED", "Claude One"), entry("claude-two")] },
  });
  expect(modelCatalogResultSchema.parse(result.catalog)).toEqual(result.catalog);
  const [url, init] = transport.mock.calls[1]!;
  expect(new URL(String(url)).origin + new URL(String(url)).pathname).toBe("https://api.anthropic.com/v1/models");
  expect(new URL(String(url)).searchParams.get("after_id")).toBe("next&cursor");
  expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-catalog-key");
  expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
});

test("catalog stops at five pages and retains the first five results", async () => {
  let page = 0;
  const transport = vi.fn<typeof fetch>(async () => {
    const id = `claude-${++page}`;
    return Response.json({ data: [{ id }], has_more: true, last_id: id });
  });
  const result = await read(transport);
  expect(transport).toHaveBeenCalledTimes(5);
  expect(result).toMatchObject({ catalog: { status: "PARTIAL", reason: null }, truncated: true });
  expect(result.catalog.models.map(model => model.modelId)).toEqual(["claude-1", "claude-2", "claude-3", "claude-4", "claude-5"]);
});

test.each([2000, 2001])("catalog marks the 2000-item limit for a vendor response of %i items", async count => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    data: Array.from({ length: count }, (_, index) => ({ id: `provider/model-${index}:free` })),
  }));
  const result = await read(transport, { ...revision, presetId: "openai", protocol: "OPENAI_RESPONSES" });
  expect(result).toMatchObject({ catalog: { status: "PARTIAL" }, truncated: true });
  expect(result.catalog.models).toHaveLength(2000);
  expect(result.catalog.models.at(-1)?.modelId).toBe("provider/model-1999:free");
  expect(transport).toHaveBeenCalledTimes(1);
});

test("a streamed oversized page keeps completed pages and reports the fixed limit error", async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" }))
    .mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    })));
  expect(await read(transport)).toMatchObject({
    truncated: true, catalog: { status: "PARTIAL", reason: "MODEL_RESPONSE_TOO_LARGE", models: [entry("first")] },
  });
});

test("DeepSeek accepts a model page of exactly 2 MiB", async () => {
  const body = JSON.stringify({ data: [{ id: "deepseek-flash" }] }).padEnd(2 * 1024 * 1024);
  const transport = vi.fn<typeof fetch>(async () => new Response(body));
  const result = await read(transport, {
    ...revision, presetId: "deepseek", protocol: "OPENAI_CHAT", baseUrl: "https://api.deepseek.com",
  });
  expect(result).toMatchObject({ truncated: false, catalog: { status: "COMPLETE", models: [entry("deepseek-flash")] } });
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]![0]).toBe("https://api.deepseek.com/models");
});

test.each([
  ["OPENAI_CHAT", "authorization", "Bearer synthetic-catalog-key"],
  ["OPENAI_RESPONSES", "authorization", "Bearer synthetic-catalog-key"],
  ["ANTHROPIC_MESSAGES", "x-api-key", "synthetic-catalog-key"],
  ["GEMINI_GENERATE_CONTENT", "x-goog-api-key", "synthetic-catalog-key"],
] as const)("custom %s discovers through the selected protocol with its own authentication", async (protocol, header, key) => {
  const payload = protocol === "GEMINI_GENERATE_CONTENT"
    ? { models: [{ name: "models/example-model", supportedGenerationMethods: ["generateContent"] }] }
    : { data: [{ id: "example-model" }] };
  const transport = vi.fn<typeof fetch>(async () => Response.json(payload));
  const result = await read(transport, { ...revision, presetId: "custom", protocol, baseUrl: "https://gateway.example.com/tenant/v1" });
  expect(result.catalog.models).toEqual([entry("example-model")]);
  expect(transport).toHaveBeenCalledOnce();
  const [url, init] = transport.mock.calls[0]!;
  expect(url).toBe("https://gateway.example.com/tenant/v1/models");
  expect(new Headers(init?.headers).get(header)).toBe(key);
});

test("catalog timeout covers all pages and preserves completed results", async () => {
  vi.useFakeTimers();
  try {
    const transport = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(
        Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" }),
      ), 10_000)))
      .mockImplementationOnce(() => new Promise(() => {}));
    const result = read(transport);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({
      truncated: false, catalog: { status: "PARTIAL", reason: "MODEL_TIMEOUT", models: [entry("first")] },
    });
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("a failed request after the first page preserves results without flagging a limit", async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" }))
    .mockRejectedValueOnce(new Error("synthetic network failure"));
  expect(await read(transport)).toMatchObject({
    truncated: false, catalog: { status: "PARTIAL", reason: "MODEL_NETWORK_ERROR", models: [entry("first")] },
  });
});

test("Gemini filters generation capabilities and removes one resource prefix", async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({
      models: [
        { name: "models/gemini-flash", displayName: "Gemini Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/models/retained", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
        { name: "models/speech", outputModalities: ["AUDIO"], supportedGenerationMethods: ["generateContent"] },
      ],
      nextPageToken: "opaque#token",
    }))
    .mockResolvedValueOnce(Response.json({ models: [] }));
  const result = await read(transport, {
    ...revision, presetId: "gemini", protocol: "GEMINI_GENERATE_CONTENT",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  });
  expect(result.catalog.models).toEqual([entry("gemini-flash", "DISCOVERED", "Gemini Flash"), entry("models/retained")]);
  const [url, init] = transport.mock.calls[1]!;
  expect(new URL(String(url)).searchParams.get("pageToken")).toBe("opaque#token");
  expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("synthetic-catalog-key");
  expect(String(url)).not.toContain("synthetic-catalog-key");
});

test.each(["qwen", "doubao"] as const)("%s explicitly leaves model entry manual", async presetId => {
  const transport = vi.fn<typeof fetch>();
  expect(await read(transport, { ...revision, presetId, protocol: "OPENAI_CHAT" })).toMatchObject({
    truncated: false, catalog: { status: "FAILED", reason: "MODEL_REQUEST_UNSUPPORTED", models: [] },
  });
  expect(transport).not.toHaveBeenCalled();
});

test("OpenRouter keeps text output and SiliconFlow China uses the documented chat filter", async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: [
      { id: "maker/chat:free", name: "Chat", architecture: { output_modalities: ["text", "image"] } },
      { id: "maker/image", architecture: { output_modalities: ["image"] } },
      { id: "openrouter/auto", architecture: { output_modalities: ["text"] } },
    ] }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: "maker/chat" }] }));
  expect((await read(transport, {
    ...revision, presetId: "openrouter", protocol: "OPENAI_CHAT", baseUrl: "https://openrouter.ai/api/v1",
  })).catalog.models).toEqual([entry("maker/chat:free", "DISCOVERED", "Chat")]);
  expect((await read(transport, {
    ...revision, presetId: "siliconflow", protocol: "OPENAI_CHAT", baseUrl: "https://api.siliconflow.cn/v1",
  })).catalog.models).toEqual([entry("maker/chat")]);
  expect(new URL(String(transport.mock.calls[1]![0])).searchParams.get("sub_type")).toBe("chat");
});

test("catalog entries and pagination cannot echo the active Key into public state or a URL", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({
    data: [
      { id: "model-synthetic-catalog-key", display_name: "Reflected ID" },
      { id: "valid-model", display_name: "Bearer synthetic-catalog-key" },
    ],
    has_more: true, last_id: "cursor-synthetic-catalog-key",
  }));
  expect(await read(transport)).toMatchObject({
    truncated: false,
    catalog: { status: "PARTIAL", reason: "MODEL_RESPONSE_INVALID", models: [entry("valid-model")] },
  });
  expect(transport).toHaveBeenCalledOnce();
});

test("a failed refresh keeps the prior directory, manual aliases and exact selection", async () => {
  const selected = "provider/selected:free";
  const previous = [entry(selected, "DISCOVERED", "我的别名"), entry("manual", "MANUAL", "手动")];
  const { catalog: failed } = await read(async () => new Response("provider secret", { status: 503 }));
  expect(mergeModelCatalog(previous, failed, selected)).toEqual({ models: previous, selectedMissingFromCatalog: false });
  const refreshed = { ...failed, models: [entry("new"), entry("manual", "DISCOVERED", "目录名称")], status: "COMPLETE" } as const;
  const merged = mergeModelCatalog(previous, refreshed, selected);
  expect(merged.selectedMissingFromCatalog).toBe(true);
  expect(merged.models).toEqual(expect.arrayContaining([...previous, entry("new")]));
  expect(merged.models).toHaveLength(3);
});

test("a complete catalog replaces old provider names while a partial refresh keeps unvisited entries", () => {
  const previous = [
    entry("stale", "DISCOVERED", "Old vendor label"),
    entry("current", "DISCOVERED", "Changed vendor label"),
    entry("manual", "MANUAL", "User alias"),
  ];
  const models = [entry("current", "DISCOVERED", "New vendor label"), entry("manual", "DISCOVERED", "Vendor label")];
  expect(mergeModelCatalog(previous, { status: "COMPLETE", models }, null).models).toEqual([previous[2], models[0]]);
  expect(mergeModelCatalog(previous, { status: "PARTIAL", models }, null).models).toEqual([previous[2], models[0], previous[0]]);
});
