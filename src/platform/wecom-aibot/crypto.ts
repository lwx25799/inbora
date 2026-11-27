import { createDecipheriv } from 'node:crypto';
import { Blocked } from '../../core/contracts.js';
import { officialApiEndpointDigest } from '../official-api-base.js';

const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 16;
const PKCS7_BLOCK_BYTES = 32;
const STRICT_BASE64_44_PATTERN = /^[A-Za-z0-9+/]{43}=$/u;
const STRICT_BASE64_43_PATTERN = /^[A-Za-z0-9+/]{43}$/u;

/**
 * Decode a WeCom 32-byte AES key supplied as either 43-char unpadded Base64
 * or 44-char standard Base64. Never includes key material in thrown errors.
 */
export function decodeWecomAesKey(aesKey: string): Buffer {
  if (typeof aesKey !== 'string') {
    throw new Blocked('WECOM_CRYPTO_KEY_INVALID');
  }
  let normalized: string;
  if (STRICT_BASE64_43_PATTERN.test(aesKey)) {
    normalized = `${aesKey}=`;
  } else if (STRICT_BASE64_44_PATTERN.test(aesKey)) {
    normalized = aesKey;
  } else {
    throw new Blocked('WECOM_CRYPTO_KEY_INVALID');
  }

  const key = Buffer.from(normalized, 'base64');
  if (key.length !== AES_KEY_BYTES || key.toString('base64') !== normalized) {
    key.fill(0);
    throw new Blocked('WECOM_CRYPTO_KEY_INVALID');
  }
  return key;
}

/**
 * Decrypt a WeCom aibot media/file attachment using AES-256-CBC with IV = key[0..15]
 * and fixed-length 32-byte constant-time PKCS#7 padding validation.
 * Error messages never include key material or plaintext fragments.
 */
export function decryptWecomAttachment(
  encryptedBuffer: Buffer | Uint8Array,
  aesKey: string,
): Buffer {
  if (!(encryptedBuffer instanceof Uint8Array)) {
    throw new Blocked('WECOM_CRYPTO_CIPHERTEXT_INVALID');
  }
  if (
    encryptedBuffer.byteLength < PKCS7_BLOCK_BYTES
    || encryptedBuffer.byteLength % PKCS7_BLOCK_BYTES !== 0
  ) {
    throw new Blocked('WECOM_CRYPTO_CIPHERTEXT_INVALID');
  }

  const key = decodeWecomAesKey(aesKey);
  const iv = Buffer.from(key.subarray(0, AES_IV_BYTES));
  let decrypted: Buffer | undefined;

  try {
    let head: Buffer;
    let tail: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-cbc', key, iv);
      decipher.setAutoPadding(false);
      head = decipher.update(encryptedBuffer);
      tail = decipher.final();
    } catch {
      throw new Blocked('WECOM_CRYPTO_DECRYPT_FAILED');
    }

    decrypted = Buffer.concat([head, tail]);
    head.fill(0);
    tail.fill(0);

    if (decrypted.length < PKCS7_BLOCK_BYTES || decrypted.length % PKCS7_BLOCK_BYTES !== 0) {
      throw new Blocked('WECOM_CRYPTO_PADDING_INVALID');
    }

    // Constant-time scan across the final 32-byte block with masked accumulation.
    const pad = decrypted[decrypted.length - 1]!;
    const padInRange = ((pad - 1) >>> 31) ^ 1; // 1 iff pad >= 1
    const padWithinBlock = ((PKCS7_BLOCK_BYTES - pad) >>> 31) ^ 1; // 1 iff pad <= 32
    const padValid = padInRange & padWithinBlock;
    const effectivePad = padValid === 1 ? pad : 0;

    let diff = padValid ^ 1;
    const tailStart = decrypted.length - PKCS7_BLOCK_BYTES;
    for (let offset = 0; offset < PKCS7_BLOCK_BYTES; offset++) {
      const posFromEnd = PKCS7_BLOCK_BYTES - offset;
      const inPad = (posFromEnd - effectivePad - 1) >>> 31; // 1 iff posFromEnd <= effectivePad
      const mask = (-inPad) & 0xff;
      diff |= (decrypted[tailStart + offset]! ^ pad) & mask;
    }

    if (diff !== 0) {
      throw new Blocked('WECOM_CRYPTO_PADDING_INVALID');
    }

    return Buffer.from(decrypted.subarray(0, decrypted.length - pad));
  } finally {
    key.fill(0);
    iv.fill(0);
    decrypted?.fill(0);
  }
}

/**
 * Compute an irreversible SHA-256 digest aligned with official-api-base.ts.
 */
export function computeWecomEndpointDigest(wsUrl: string): string {
  return officialApiEndpointDigest(wsUrl, { allowedProtocols: ['wss:'] });
}
