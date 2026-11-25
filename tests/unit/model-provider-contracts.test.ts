import { expect, test } from "vitest";
import {
  modelGrantSchema, modelGrantV2Schema, replyPolicySchema, replyPolicyV2Schema,
} from "../../src/contracts/automation.js";
import { commandSchema } from "../../src/contracts/client.js";
import { digest } from "../../src/core/contracts.js";
import {
  endpointDigest, MODEL_PROVIDER_PRESETS, normalizeBaseUrl, previewGenerationUrl,
} from "../../src/ai/provider-presets.js";
import {
  isValidModelId,
  MODEL_PRESET_IDS,
  MODEL_PROTOCOLS,
  modelBaseUrlSchema,
  modelIdSchema,
  modelProvidersCommandSchema,
  modelRouteSnapshotSchema,
  modelUsageDetailsSchema,
  publicModelStateSchema,
} from "../../src/contracts/model-providers.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const commandId = "00000000-0000-4000-8000-000000000002";
const route = { connectionId, routeRevision: 1 };
const binding = {
  ...route,
  selectionRevision: 2,
  protocol: "OPENAI_CHAT",
  endpointDigest: "a".repeat(64),
};
const command = "modelProviders";
const modelId = "Provider/Model-1.2:free_v1";
const save = {
  command, action: "save", connectionId: null, expectedVersion: 0,
  name: "自定义连接", presetId: "custom", protocol: "OPENAI_CHAT",
  baseUrl: "https://example.com/workspace/v1", region: null,
  manualModels: [{ modelId, displayName: "手动模型" }],
};

test("presets expose all official defaults, region endpoints and catalog capabilities", () => {
  expect(Object.keys(MODEL_PROVIDER_PRESETS)).toEqual([...MODEL_PRESET_IDS]);
  const expected = [
    ["deepseek", "OPENAI_CHAT", "https://api.deepseek.com", true],
    ["openai", "OPENAI_RESPONSES", "https://api.openai.com/v1", true],
    ["anthropic", "ANTHROPIC_MESSAGES", "https://api.anthropic.com/v1", true],
    ["gemini", "GEMINI_GENERATE_CONTENT", "https://generativelanguage.googleapis.com/v1beta", true],
    ["qwen", "OPENAI_CHAT", "https://dashscope.aliyuncs.com/compatible-mode/v1", false],
    ["doubao", "OPENAI_CHAT", "https://ark.cn-beijing.volces.com/api/v3", false],
    ["siliconflow", "OPENAI_CHAT", "https://api.siliconflow.cn/v1", true],
    ["openrouter", "OPENAI_CHAT", "https://openrouter.ai/api/v1", true],
    ["custom", null, null, true],
  ] as const;
  for (const [id, protocol, baseUrl, supportsCatalog] of expected) {
    expect(MODEL_PROVIDER_PRESETS[id]).toMatchObject({ protocol, baseUrl, supportsCatalog });
  }
  expect(MODEL_PROVIDER_PRESETS.qwen.regions.map(({ id, baseUrl }) => [id, baseUrl])).toEqual([
    ["beijing", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
    ["singapore", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["us", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"],
  ]);
  expect(MODEL_PROVIDER_PRESETS.siliconflow.regions.map(({ baseUrl }) => baseUrl)).toEqual([
    "https://api.siliconflow.cn/v1", "https://api.siliconflow.com/v1",
  ]);
  expect(MODEL_PROVIDER_PRESETS.doubao).toMatchObject({
    regions: [{ id: "beijing" }], modelIdKinds: ["MODEL_ID", "ENDPOINT_ID"],
  });
});

test("preview appends only the protocol operation and digests the normalized endpoint", () => {
  const base = "https://API.Example.COM:443/workspace/v1/";
  expect(normalizeBaseUrl(base)).toBe("https://api.example.com/workspace/v1");
  expect(endpointDigest(base)).toMatch(/^[0-9a-f]{64}$/u);
  expect(endpointDigest(base)).toBe(endpointDigest(normalizeBaseUrl(base)));
  expect(endpointDigest(base)).toBe(digest("https://api.example.com/workspace/v1"));
  expect(endpointDigest(base)).not.toBe(endpointDigest("https://api.example.com/workspace/v2"));
  const paths = ["/chat/completions", "/responses", "/messages", "/models/Provider%2FModel%3Afree:generateContent"];
  for (const [index, protocol] of MODEL_PROTOCOLS.entries()) {
    expect(previewGenerationUrl(base, protocol, "Provider/Model:free")).toBe(normalizeBaseUrl(base) + paths[index]);
  }
});

test("normalization rejects private destinations and ambiguous paths before a credential is used", () => {
  const blocked = [
    "http://api.example.com", "https://user:secret@api.example.com/v1",
    "https://api.example.com/v1?key=secret", "https://api.example.com/v1#secret",
    "https://api.example.com/va\u0000lue", "https://api.example.com/v1//project", "https://api.example.com/v1/v1",
    "https://api.example.com/workspace/../v1", "https://api.example.com/%2e%2e/v1",
    "https://api.example.com/v1%2fextra", "https://api.example.com/path%0a",
    ...["localhost", "127.25.0.1", "2130706433", "0.0.0.0", "10.0.0.1", "172.31.0.1",
      "192.168.2.1", "169.254.169.254", "service.local.", "service.internal", "service.home.arpa",
      "100.64.0.1", "192.88.99.2", "224.0.0.1", "240.0.0.1",
      "[::1]", "[::ffff:c0a8:101]", "[fc00::1]", "[2001:db8::1]", "[2002::1]", "[3fff::1]",
    ].map(host => `https://${host}/v1`),
  ];
  for (const url of blocked) expect(() => normalizeBaseUrl(url), url).toThrow(/HTTPS/u);
  for (const host of ["8.8.8.8", "[2606:4700::1111]"]) {
    const url = `https://${host}/v1`;
    expect(normalizeBaseUrl(url)).toBe(url);
  }
  for (const path of ["/chat/completions", "/responses", "/messages/", "/models/gemini:generateContent", "/%72esponses"]) {
    expect(() => normalizeBaseUrl("https://api.example.com/v1" + path)).toThrow(/Base URL/u);
  }
});

test("model IDs preserve the printable ASCII range and reject whitespace, Unicode and overlength IDs", () => {
  const printable = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 0x21)).join("");
  for (const valid of ["!", modelId, printable, "X".repeat(256)]) {
    expect(isValidModelId(valid)).toBe(true);
    expect(modelIdSchema.parse(valid)).toBe(valid);
  }
  for (const invalid of ["", "X".repeat(257), "a b", "a\n", "a\r", "a\t", "a\0", "a\x7f", "模型", 12, null]) {
    expect(isValidModelId(invalid)).toBe(false);
    expect(modelIdSchema.safeParse(invalid).success).toBe(false);
  }
});

test("connection save accepts every protocol and preset, including regional HTTPS base URLs", () => {
  for (const protocol of MODEL_PROTOCOLS) {
    expect(modelProvidersCommandSchema.parse({ ...save, protocol })).toMatchObject({ protocol });
  }
  for (const presetId of MODEL_PRESET_IDS) {
    expect(modelProvidersCommandSchema.parse({ ...save, presetId })).toMatchObject({ presetId });
  }
  const regional = {
    ...save, presetId: "qwen", protocol: "OPENAI_CHAT", region: "singapore",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  };
  expect(modelProvidersCommandSchema.parse(regional)).toEqual(regional);
  expect(modelProvidersCommandSchema.safeParse({ ...save, protocol: "CHAT" }).success).toBe(false);
  expect(modelProvidersCommandSchema.safeParse({ ...save, presetId: "unknown" }).success).toBe(false);
});

test("provider commands accept metadata-only saves, complete replacements and revision-checked connection pages", () => {
  const { manualModels, ...metadata } = { ...save, connectionId, expectedVersion: 2 };
  const replace = { ...metadata, manualModels, manualModelsComplete: true, expectedSelectionRevision: 3 };
  const list = { command, action: "list", offset: 20, expectedListRevision: 7 };
  for (const input of [metadata, replace, list]) expect(commandSchema.parse(input)).toEqual(input);
  for (const input of [
    { ...metadata, manualModelsComplete: true, expectedSelectionRevision: 3 },
    { ...metadata, manualModels, manualModelsComplete: true },
    { ...replace, expectedSelectionRevision: -1 },
    { ...list, expectedListRevision: -1 },
  ]) expect(commandSchema.safeParse(input).success).toBe(false);
});

test("base URLs preserve configured paths and reject secrets, local addresses and operation paths", () => {
  const valid = ["https://api.deepseek.com", "https://10.example.com/workspace/v1/", save.baseUrl];
  for (const url of valid) expect(modelBaseUrlSchema.parse(url)).toBe(url);
  const invalid = [
    "http://example.com", "https://user:secret@example.com/v1", "https://@example.com",
    "https://example.com/v1?", "https://example.com/v1#",
    "https://exam\tple.com/v1", "https://example.com/v1\0",
    "https://localhost", "https://service.local", "https://127.1", "https://192.168.1.2", "https://[::1]",
    "https://example.com/v1/v1", "https://example.com/v1//project", "https://example.com/v1/chat/completions",
    "https://example.com/v1/messages/", "https://example.com/v1beta/models/gemini:generateContent",
  ];
  for (const url of invalid) expect(modelBaseUrlSchema.safeParse(url).success, url).toBe(false);
});

test("the top-level client contract accepts all seven strict model management actions", () => {
  const keyWrite = { command, action: "setKey", connectionId, expectedVersion: 1, storage: "DPAPI", key: "synthetic" };
  const keyDelete = { command, action: "setKey", connectionId, expectedVersion: 1, storage: "DELETE" };
  const testCall = { command, action: "test", ...route, commandId, modelId, confirmed: true };
  const apply = { ...testCall, action: "apply", expectedSelectionRevision: 0 };
  const actions = [
    { command, action: "list" }, save, { ...save, connectionId, expectedVersion: 1 },
    keyWrite, { ...keyWrite, storage: "MEMORY" }, keyDelete,
    { command, action: "discover", ...route }, testCall, apply,
    { command, action: "delete", connectionId, expectedVersion: 1 },
  ];
  for (const action of actions) {
    expect(commandSchema.parse(action)).toEqual(action);
    expect(commandSchema.safeParse({ ...action, extra: true }).success).toBe(false);
  }
  for (const invalid of [
    { ...save, connectionId }, { ...save, expectedVersion: 1 },
    { ...save, manualModels: [{ modelId, source: "DISCOVERED" }] },
    { ...keyDelete, key: "synthetic" }, { ...keyWrite, key: "" }, { ...keyWrite, key: "line\r\nbreak" },
    { ...testCall, prompt: "custom" }, { ...testCall, confirmed: false },
    { ...apply, expectedSelectionRevision: -1 },
  ]) {
    expect(commandSchema.safeParse(invalid).success).toBe(false);
  }
});

test("legacy and V2 authority scopes parse independently and both enforce policy hours", () => {
  const legacy = { ownId: "owner", channels: ["DIRECT_MESSAGE"], model: "deepseek-flash", modelLimit: 5, expiresAt: null };
  const v2 = { ...legacy, model: modelId, contractVersion: 2, modelBinding: binding };
  expect(modelGrantSchema.parse(legacy)).toEqual(legacy);
  expect(modelGrantV2Schema.parse(v2)).toEqual(v2);
  expect(modelGrantV2Schema.safeParse(legacy).success).toBe(false);
  expect(modelGrantSchema.safeParse({ ...v2, model: legacy.model }).success).toBe(false);
  expect(modelGrantV2Schema.safeParse({ ...v2, contractVersion: 3 }).success).toBe(false);
  expect(modelGrantV2Schema.safeParse({ ...v2, modelBinding: { ...binding, endpointDigest: "invalid" } }).success).toBe(false);

  const policy = {
    workIds: [], futureOwnWorks: false, conversationIds: [], entireInbox: true, containsAny: [], excludesAny: [],
    instructions: "policy", startHour: 8, endHour: 18, sendLimit: 1,
  };
  expect(replyPolicySchema.parse({ ...legacy, ...policy })).toEqual({ ...legacy, ...policy });
  expect(replyPolicyV2Schema.parse({ ...v2, ...policy })).toEqual({ ...v2, ...policy });
  expect(replyPolicyV2Schema.safeParse({ ...v2, ...policy, endHour: 7 }).success).toBe(false);
});

test("a connection test carries its own command ID and cannot use a business grant", () => {
  const snapshot = { ...binding, credentialRevision: commandId, modelId, presetId: "custom" };
  const business = { ...snapshot, purpose: "REPLY_GENERATION", grantVersion: 1 };
  const probe = { ...snapshot, purpose: "PROVIDER_TEST", selectionRevision: null, grantVersion: null, commandId, testVersion: 1 };
  expect(modelRouteSnapshotSchema.parse(business)).toEqual(business);
  expect(modelRouteSnapshotSchema.parse(probe)).toEqual(probe);
  expect(modelRouteSnapshotSchema.safeParse({ ...probe, grantVersion: 1 }).success).toBe(false);
  expect(modelRouteSnapshotSchema.safeParse({ ...business, key: "synthetic" }).success).toBe(false);
});

test("usage retains unknown counts and the public state accepts only credential-free projections", () => {
  const usage = {
    inputTokens: null, outputTokens: 10, totalTokens: 19, reasoningTokens: 8,
    cacheReadTokens: 3, cacheWriteTokens: null,
  };
  expect(modelUsageDetailsSchema.parse(usage)).toEqual(usage);
  expect(modelUsageDetailsSchema.safeParse({ ...usage, totalTokens: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  expect(modelUsageDetailsSchema.safeParse({ ...usage, reasoningTokens: -1 }).success).toBe(false);

  const draft = {
    routeRevision: 1, presetId: "custom", protocol: "OPENAI_CHAT", baseUrl: save.baseUrl,
    region: null, storage: "MEMORY", keyPresent: false, keyStored: false,
    unavailableReason: "MODEL_KEY_REQUIRED", catalogResult: null, testResult: null,
  };
  const connection = {
    id: connectionId, name: save.name, presetId: "custom", version: 1,
    draftRevision: 1, models: [], modelsFetchedAt: null, draft, applied: null,
  };
  const selection = { connectionId: null, routeRevision: null, modelId: null, selectionRevision: 0 };
  expect(publicModelStateSchema.parse({ connections: [connection], selection })).toEqual({ connections: [connection], selection });
  for (const field of ["key", "ciphertext", "credentialRevision", "rawError"]) {
    expect(publicModelStateSchema.safeParse({
      connections: [{ ...connection, draft: { ...draft, [field]: "synthetic" } }], selection,
    }).success).toBe(false);
  }
  expect(publicModelStateSchema.safeParse({ connections: [], selection: { ...selection, modelId } }).success).toBe(false);
});
