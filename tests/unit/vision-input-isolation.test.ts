import { expect, test, vi } from "vitest";
import { generateModelText } from "../../src/ai/model-client.js";
import type { ModelPresetId, ModelProtocol } from "../../src/ai/model-contracts.js";
import { endpointDigest, MODEL_PROVIDER_PRESETS } from "../../src/ai/provider-presets.js";
import { buildValidatedVisionInput, MAX_VISION_IMAGE_BYTES } from "../../src/ai/vision-input.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

test("buildValidatedVisionInput isolates avatars, disabled switch, oversize, and bad magic bytes", () => {
  expect(() =>
    buildValidatedVisionInput({
      accountFeatures: { visionEnabled: false },
      sourceKind: "CUSTOMER_MESSAGE_IMAGE",
      bytes: PNG_BYTES,
      mimeType: "image/png",
    }),
  ).toThrow("VISION_INPUT_FORBIDDEN");

  for (const sourceKind of ["AVATAR", "FIXED_INSTRUCTION", "UNVERIFIED_PREVIEW"] as const) {
    expect(() =>
      buildValidatedVisionInput({
        accountFeatures: { visionEnabled: true },
        sourceKind,
        bytes: PNG_BYTES,
        mimeType: "image/png",
      }),
    ).toThrow("VISION_INPUT_FORBIDDEN");
  }

  expect(() =>
    buildValidatedVisionInput({
      accountFeatures: { visionEnabled: true },
      sourceKind: "CUSTOMER_MESSAGE_IMAGE",
      filePath: "D:\\Inbora\\.local\\avatars\\peer-1.png",
      bytes: PNG_BYTES,
      mimeType: "image/png",
    }),
  ).toThrow("VISION_INPUT_FORBIDDEN");

  expect(() =>
    buildValidatedVisionInput({
      accountFeatures: { visionEnabled: true },
      sourceKind: "CUSTOMER_MESSAGE_IMAGE",
      bytes: new Uint8Array(MAX_VISION_IMAGE_BYTES + 1),
      mimeType: "image/png",
    }),
  ).toThrow("VISION_INPUT_FORBIDDEN");

  expect(() =>
    buildValidatedVisionInput({
      accountFeatures: { visionEnabled: true },
      sourceKind: "CUSTOMER_MESSAGE_IMAGE",
      bytes: PNG_BYTES,
      mimeType: "image/jpeg",
    }),
  ).toThrow("VISION_INPUT_FORBIDDEN");

  const validPng = buildValidatedVisionInput({
    accountFeatures: { visionEnabled: true },
    sourceKind: "CUSTOMER_MESSAGE_IMAGE",
    filePath: "D:\\Inbora\\.local\\inbound\\msg-1.png",
    bytes: PNG_BYTES,
    mimeType: "image/png",
  });
  expect(validPng.mimeType).toBe("image/png");
  expect(validPng.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);

  expect(
    buildValidatedVisionInput({
      accountFeatures: { visionEnabled: true },
      sourceKind: "CUSTOMER_MESSAGE_IMAGE",
      bytes: JPEG_BYTES,
      mimeType: "image/jpeg",
    }).mimeType,
  ).toBe("image/jpeg");
  expect(
    buildValidatedVisionInput({
      accountFeatures: { visionEnabled: true },
      sourceKind: "CUSTOMER_MESSAGE_IMAGE",
      bytes: WEBP_BYTES,
      mimeType: "image/webp",
    }).mimeType,
  ).toBe("image/webp");
});

function mockProtocolSuccess(protocol: ModelProtocol) {
  switch (protocol) {
    case "OPENAI_CHAT":
      return Response.json({
        id: "chat-v",
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "图片显示快递已签收。" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      });
    case "OPENAI_RESPONSES":
      return Response.json({
        id: "resp-v",
        created_at: 0,
        model: "gpt-4o",
        status: "completed",
        output: [{
          type: "message",
          id: "msg-v",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "图片显示快递已签收。", annotations: [] }],
        }],
        usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
      });
    case "ANTHROPIC_MESSAGES":
      return Response.json({
        id: "msg-v",
        type: "message",
        role: "assistant",
        model: "claude-3-7-sonnet-20250219",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "图片显示快递已签收。" }],
        usage: { input_tokens: 10, output_tokens: 6 },
      });
    case "GEMINI_GENERATE_CONTENT":
      return Response.json({
        modelVersion: "gemini-2.5-flash",
        candidates: [{
          content: { role: "model", parts: [{ text: "图片显示快递已签收。" }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6, totalTokenCount: 16 },
      });
  }
}

test.each([
  ["openai", "OPENAI_CHAT", "gpt-4o"],
  ["openai", "OPENAI_RESPONSES", "gpt-4o"],
  ["anthropic", "ANTHROPIC_MESSAGES", "claude-3-7-sonnet-20250219"],
  ["gemini", "GEMINI_GENERATE_CONTENT", "gemini-2.5-flash"],
] as const)(
  "generateModelText supports validated vision input across %s (%s) with maxRetries=0",
  async (presetId: ModelPresetId, protocol: ModelProtocol, modelId: string) => {
    const baseUrl = MODEL_PROVIDER_PRESETS[presetId].baseUrl!;
    const route = {
      connectionId: "00000000-0000-4000-8000-000000000011",
      routeRevision: 1,
      presetId,
      protocol,
      credentialRevision: "00000000-0000-4000-8000-000000000012",
    };
    const revision = { ...route, baseUrl, region: null, storage: "MEMORY" as const, createdAt: 0 };
    const snapshot = {
      ...route,
      endpointDigest: endpointDigest(baseUrl),
      modelId,
      purpose: "REPLY_GENERATION" as const,
      selectionRevision: 1,
      grantVersion: 1,
    };

    const imagePart = buildValidatedVisionInput({
      accountFeatures: { visionEnabled: true },
      sourceKind: "CUSTOMER_MESSAGE_IMAGE",
      bytes: PNG_BYTES,
      mimeType: "image/png",
    });

    const blockedTransport = vi.fn<typeof fetch>();
    await expect(
      generateModelText({
        revision,
        snapshot,
        apiKey: "sk-vision-key",
        allowVision: false,
        messages: [{ role: "user", content: [{ type: "text", text: "请看图" }, imagePart] }],
        transport: blockedTransport,
      }),
    ).rejects.toThrow("VISION_INPUT_FORBIDDEN");
    expect(blockedTransport).not.toHaveBeenCalled();

    const transport = vi.fn<typeof fetch>(async () => mockProtocolSuccess(protocol));
    const result = await generateModelText({
      revision,
      snapshot,
      apiKey: "sk-vision-key",
      allowVision: true,
      messages: [{ role: "user", content: [{ type: "text", text: "请看图" }, imagePart] }],
      transport,
    });
    expect(result.text).toBe("图片显示快递已签收。");
    expect(transport).toHaveBeenCalledTimes(1);
    const body = String(transport.mock.calls[0]![1]?.body);
    expect(body).toContain(Buffer.from(PNG_BYTES).toString("base64"));
  },
);
