/**
 * Zero-dependency WXBizMsgCrypt implementation for WeChat Customer Service (WeChat KF).
 * Ported from pawastation/wechat-kf (MIT, commit 68b7d367f6cf) with strict constant-time
 * signature comparison, full-byte 32-byte PKCS#7 validation, and receiverId enforcement.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WeChatKfError, type WeChatKfDecryptedPayload } from './types.js';

const AES_KEY_BASE64_LENGTH = 43;
const AES_KEY_BYTES = 32;
const AES_BLOCK_BYTES = 16;
const PKCS7_BLOCK_BYTES = 32;
const BASE64_43_PATTERN = /^[A-Za-z0-9+/]{43}$/u;
const BASE64_CIPHERTEXT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const SHA1_HEX_PATTERN = /^[0-9a-f]{40}$/iu;

function constantTimeUtf8Equal(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

/** Validate a 43-character EncodingAESKey and decode it into the 32-byte AES-256 key. */
export function deriveAesKey(encodingAESKey: string): Buffer {
  if (typeof encodingAESKey !== 'string' || encodingAESKey.length !== AES_KEY_BASE64_LENGTH || !BASE64_43_PATTERN.test(encodingAESKey)) {
    throw new WeChatKfError('WECHAT_KF_INVALID_AES_KEY');
  }
  const key = Buffer.from(`${encodingAESKey}=`, 'base64');
  if (key.length !== AES_KEY_BYTES) {
    throw new WeChatKfError('WECHAT_KF_INVALID_AES_KEY');
  }
  // Reject non-canonical trailing bits in the 43rd Base64 character.
  if (key.toString('base64').slice(0, AES_KEY_BASE64_LENGTH) !== encodingAESKey) {
    throw new WeChatKfError('WECHAT_KF_INVALID_AES_KEY');
  }
  return key;
}

/** Compute SHA1(sort([token, timestamp, nonce, encrypt]).join('')). */
export function computeSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  if (typeof token !== 'string' || typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof encrypt !== 'string') {
    throw new WeChatKfError('WECHAT_KF_INVALID_SIGNATURE');
  }
  const joined = [token, timestamp, nonce, encrypt].sort().join('');
  return createHash('sha1').update(joined, 'utf8').digest('hex');
}

/** Constant-time SHA1 callback signature verification using node:crypto timingSafeEqual. */
export function verifySignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  expectedSignature: string,
): boolean {
  if (
    typeof token !== 'string' || !token.length ||
    typeof timestamp !== 'string' || !timestamp.length ||
    typeof nonce !== 'string' || !nonce.length ||
    typeof encrypt !== 'string' || !encrypt.length ||
    typeof expectedSignature !== 'string' || !SHA1_HEX_PATTERN.test(expectedSignature)
  ) {
    return false;
  }
  const computed = computeSignature(token, timestamp, nonce, encrypt);
  const actualBuf = Buffer.from(computed, 'hex');
  const expectedBuf = Buffer.from(expectedSignature.toLowerCase(), 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

/** Apply WeChat 32-byte block PKCS#7 padding. */
export function pkcs7Pad(input: Buffer): Buffer {
  const padAmount = PKCS7_BLOCK_BYTES - (input.length % PKCS7_BLOCK_BYTES);
  const pad = Buffer.alloc(padAmount, padAmount);
  return Buffer.concat([input, pad]);
}

/** Validate and strip WeChat 32-byte block PKCS#7 padding, inspecting every padding byte. */
export function pkcs7Unpad(input: Buffer): Buffer {
  if (input.length === 0 || input.length % AES_BLOCK_BYTES !== 0) {
    throw new WeChatKfError('WECHAT_KF_INVALID_PADDING');
  }
  const pad = input[input.length - 1];
  if (pad === undefined || pad < 1 || pad > PKCS7_BLOCK_BYTES || pad > input.length) {
    throw new WeChatKfError('WECHAT_KF_INVALID_PADDING');
  }
  let diff = 0;
  for (let i = input.length - pad; i < input.length; i++) {
    diff |= (input[i] ?? 0) ^ pad;
  }
  if (diff !== 0) {
    throw new WeChatKfError('WECHAT_KF_INVALID_PADDING');
  }
  return input.subarray(0, input.length - pad);
}

/**
 * Encrypt plaintext according to WXBizMsgCrypt:
 * AES-256-CBC(IV = aesKey[0..16], PKCS#7(32B)(random16 || be32(len) || msg || corpId)).
 */
export function encrypt(
  encodingAESKey: string,
  plaintext: string,
  corpId: string,
  randomPrefix?: Buffer,
): string {
  const aesKey = deriveAesKey(encodingAESKey);
  const iv = aesKey.subarray(0, AES_BLOCK_BYTES);
  const random16 = randomPrefix ?? randomBytes(AES_BLOCK_BYTES);
  if (random16.length !== AES_BLOCK_BYTES) {
    throw new WeChatKfError('WECHAT_KF_INVALID_PAYLOAD');
  }
  const msgBuf = Buffer.from(plaintext, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const corpBuf = Buffer.from(corpId, 'utf8');
  const padded = pkcs7Pad(Buffer.concat([random16, lenBuf, msgBuf, corpBuf]));

  const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/**
 * Decrypt a Base64-encoded WXBizMsgCrypt ciphertext and verify structure and optional corpId.
 */
export function decrypt(
  encodingAESKey: string,
  encryptedBase64: string,
  expectedCorpId?: string,
): WeChatKfDecryptedPayload {
  const aesKey = deriveAesKey(encodingAESKey);
  if (typeof encryptedBase64 !== 'string') {
    throw new WeChatKfError('WECHAT_KF_INVALID_CIPHERTEXT');
  }
  const normalized = encryptedBase64.replace(/\s+/gu, '');
  if (!normalized.length || normalized.length % 4 !== 0 || !BASE64_CIPHERTEXT_PATTERN.test(normalized)) {
    throw new WeChatKfError('WECHAT_KF_INVALID_CIPHERTEXT');
  }
  const cipherBuf = Buffer.from(normalized, 'base64');
  if (cipherBuf.length < PKCS7_BLOCK_BYTES || cipherBuf.length % AES_BLOCK_BYTES !== 0) {
    throw new WeChatKfError('WECHAT_KF_INVALID_CIPHERTEXT');
  }

  const iv = aesKey.subarray(0, AES_BLOCK_BYTES);
  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-cbc', aesKey, iv);
    decipher.setAutoPadding(false);
    decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  } catch {
    throw new WeChatKfError('WECHAT_KF_INVALID_CIPHERTEXT');
  }

  const content = pkcs7Unpad(decrypted);
  if (content.length < 20) {
    throw new WeChatKfError('WECHAT_KF_INVALID_PAYLOAD');
  }
  const msgLen = content.readUInt32BE(16);
  if (msgLen > content.length - 20) {
    throw new WeChatKfError('WECHAT_KF_INVALID_PAYLOAD');
  }

  const message = content.subarray(20, 20 + msgLen).toString('utf8');
  const receiverId = content.subarray(20 + msgLen).toString('utf8');
  if (expectedCorpId !== undefined && !constantTimeUtf8Equal(receiverId, expectedCorpId)) {
    throw new WeChatKfError('WECHAT_KF_RECEIVER_ID_MISMATCH');
  }
  return { message, receiverId };
}
