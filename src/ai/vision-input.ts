import { createHash } from "node:crypto";
import type { AccountAiFeatures, MediaAssetMimeType } from "../contracts/ai-runtime.js";
import { Blocked } from "../core/contracts.js";

export const MAX_VISION_IMAGE_BYTES = 4 * 1024 * 1024;

export type VisionImageSourceKind =
  | "CUSTOMER_MESSAGE_IMAGE"
  | "AVATAR"
  | "FIXED_INSTRUCTION"
  | "UNVERIFIED_PREVIEW";

export interface VisionInputCandidate {
  accountFeatures: Pick<AccountAiFeatures, "visionEnabled">;
  sourceKind: VisionImageSourceKind | string;
  filePath?: string | null | undefined;
  bytes: Uint8Array;
  mimeType: MediaAssetMimeType | string;
}

export interface ValidatedVisionImagePart {
  readonly kind: "VISION_IMAGE";
  readonly sourceKind: "CUSTOMER_MESSAGE_IMAGE";
  readonly mimeType: MediaAssetMimeType;
  readonly bytes: Uint8Array;
  readonly imageDataUrl: string;
  readonly sha256: string;
}

/** Detect PNG, JPEG, or WEBP strictly from file header magic bytes. */
export function detectImageMimeType(bytes: Uint8Array): MediaAssetMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function rejectVisionInput(): never {
  throw new Blocked("VISION_INPUT_FORBIDDEN");
}

export function isValidatedVisionImagePart(value: unknown): value is ValidatedVisionImagePart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ValidatedVisionImagePart>;
  if (
    candidate.kind !== "VISION_IMAGE" ||
    candidate.sourceKind !== "CUSTOMER_MESSAGE_IMAGE" ||
    !(candidate.bytes instanceof Uint8Array) ||
    candidate.bytes.byteLength === 0 ||
    candidate.bytes.byteLength > MAX_VISION_IMAGE_BYTES ||
    typeof candidate.mimeType !== "string" ||
    typeof candidate.imageDataUrl !== "string" ||
    typeof candidate.sha256 !== "string"
  ) {
    return false;
  }
  return detectImageMimeType(candidate.bytes) === candidate.mimeType;
}

/**
 * Strictly isolates multimodal vision inputs: only customer message images when the account's
 * `visionEnabled` switch is explicitly ON, within 4 MiB, magic-byte verified, and never from avatars.
 */
export function buildValidatedVisionInput(input: VisionInputCandidate): ValidatedVisionImagePart {
  if (!input.accountFeatures?.visionEnabled) rejectVisionInput();
  if (input.sourceKind !== "CUSTOMER_MESSAGE_IMAGE") rejectVisionInput();

  if (input.filePath !== undefined && input.filePath !== null) {
    if (typeof input.filePath !== "string" || !input.filePath.trim() || input.filePath.includes("\0")) {
      rejectVisionInput();
    }
    if (input.filePath.toLowerCase().includes("avatars")) {
      rejectVisionInput();
    }
  }

  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_VISION_IMAGE_BYTES) {
    rejectVisionInput();
  }

  const detectedMime = detectImageMimeType(input.bytes);
  if (!detectedMime || detectedMime !== input.mimeType) {
    rejectVisionInput();
  }

  const copy = new Uint8Array(input.bytes);
  const sha256 = createHash("sha256").update(copy).digest("hex");
  const imageDataUrl = `data:${detectedMime};base64,${Buffer.from(copy).toString("base64")}`;

  return Object.freeze({
    kind: "VISION_IMAGE",
    sourceKind: "CUSTOMER_MESSAGE_IMAGE",
    mimeType: detectedMime,
    bytes: copy,
    imageDataUrl,
    sha256,
  });
}
