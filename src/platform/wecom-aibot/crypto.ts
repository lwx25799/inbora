import { createDecipheriv, createHash } from 'node:crypto';
import { Blocked } from '../../core/contracts.js';

const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 16;
const AES_CIPHER_BLOCK_BYTES = 16;
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
 * and strict manual 32-byte PKCS#7 padding validation.
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
    encryptedBuffer.byteLength < AES_CIPHER_BLOCK_BYTES
    || encryptedBuffer.byteLength % AES_CIPHER_BLOCK_BYTES !== 0
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

    if (decrypted.length === 0) {
      throw new Blocked('WECOM_CRYPTO_PADDING_INVALID');
    }

    const pad = decrypted[decrypted.length - 1]!;
    if (pad < 1 || pad > PKCS7_BLOCK_BYTES || pad > decrypted.length) {
      throw new Blocked('WECOM_CRYPTO_PADDING_INVALID');
    }

    // Constant-time byte-by-byte verification over all padding bytes.
    let diff = 0;
    const padStart = decrypted.length - pad;
    for (let i = padStart; i < decrypted.length; i++) {
      diff |= decrypted[i]! ^ pad;
    }
    if (diff !== 0) {
      throw new Blocked('WECOM_CRYPTO_PADDING_INVALID');
    }

    return Buffer.from(decrypted.subarray(0, padStart));
  } finally {
    key.fill(0);
    iv.fill(0);
    decrypted?.fill(0);
  }
}

/**
 * Compute an irreversible SHA-256 digest of a sanitized WSS endpoint (origin + path).
 */
export function computeWecomEndpointDigest(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const port = parsed.port && parsed.port !== '443' ? `:${parsed.port}` : '';
  const canonical = `${parsed.protocol}//${host}${port}${parsed.pathname || '/'}`;
  return createHash('sha256').update(canonical).digest('hex');
}
