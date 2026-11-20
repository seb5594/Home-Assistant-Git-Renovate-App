// Secrets at rest: tokens are encrypted with AES-256-GCM before they reach the database.
// The key lives in its own file next to the data, so a copy of the database alone is useless.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PREFIX = 'v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Loads the key, creating it on the first start. */
export function loadOrCreateKey(keyFile) {
  try {
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length === KEY_BYTES) return key;
  } catch {
    // No key yet: create one below.
  }
  const key = randomBytes(KEY_BYTES);
  mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return key;
}

export function createVault(key) {
  return {
    encrypt(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64');
    },
    decrypt(text) {
      if (typeof text !== 'string' || !text.startsWith(PREFIX)) throw new Error('Unknown secret format');
      const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    },
  };
}

/** A short random identifier that is safe in URLs and file names. */
export function randomId(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}

export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hmacSha256Hex(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}
