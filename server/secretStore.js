'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

// Credential encryption at rest (site passwords, and SSH private keys once
// key auth is wired). AES-256-GCM; stored form is `enc:v1:<b64(iv|tag|ct)>`.
//
// Key precedence:
//   1. PARALLEX_SECRET env var (scrypt-derived) — keeps the key out of the
//      /config volume entirely; set it in docker-compose/.env.
//   2. Auto-generated random keyfile /config/.secret (mode 0600).
// decrypt() tries the primary key first, then the keyfile as fallback, so
// setting PARALLEX_SECRET later still reads old values; the boot migration
// re-encrypts everything with the primary key.

const PREFIX = 'enc:v1:';
let configDir = '/config';
let keys = null; // [primary, ...fallbacks]

function init(dir) {
  configDir = dir;
  keys = null;
  signingKey = null;
}

let signingKey = null;

// Session-cookie HMAC key, derived from the primary encryption key with a
// distinct HKDF label so cookie signing and credential encryption never
// share key material directly.
function getSigningKey() {
  if (!signingKey) {
    signingKey = Buffer.from(
      crypto.hkdfSync('sha256', loadKeys()[0], 'parallex-lftp', 'session-signing.v1', 32)
    );
  }
  return signingKey;
}

function loadKeys() {
  if (keys) return keys;
  const list = [];
  const secret = process.env.PARALLEX_SECRET;
  if (secret && secret.trim()) {
    list.push(crypto.scryptSync(secret, 'parallex-lftp.credentials.v1', 32));
  }
  const keyPath = path.join(configDir, '.secret');
  let fileKey = null;
  try {
    const raw = fs.readFileSync(keyPath);
    if (raw.length >= 32) fileKey = raw.subarray(0, 32);
  } catch (_) { /* no keyfile yet */ }
  if (fileKey) {
    list.push(fileKey);
  } else if (list.length === 0) {
    fileKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, fileKey, { mode: 0o600 });
    log('secrets', `generated new encryption key at ${keyPath}`);
    list.push(fileKey);
  }
  keys = list;
  return keys;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plain) {
  if (plain == null || plain === '' || isEncrypted(plain)) return plain;
  const key = loadKeys()[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decrypt(value) {
  if (!isEncrypted(value)) return value; // legacy plaintext (pre-migration)
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  for (const key of loadKeys()) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (_) { /* wrong key — try next */ }
  }
  const err = new Error(
    'stored credential cannot be decrypted (encryption secret changed?) — re-enter the password for this site'
  );
  err.code = 'SECRET';
  err.status = 409;
  throw err;
}

function decryptWith(value, key) {
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// Boot migration for one stored value: plaintext gets encrypted; values
// encrypted under a fallback key get re-encrypted with the primary key;
// values already under the primary key (or unreadable) stay untouched.
function migrateValue(value) {
  if (value == null || value === '') return { changed: false, value };
  if (!isEncrypted(value)) return { changed: true, value: encrypt(value) };
  const [primary] = loadKeys();
  try {
    decryptWith(value, primary);
    return { changed: false, value };
  } catch (_) { /* not the primary key */ }
  try {
    return { changed: true, value: encrypt(decrypt(value)) };
  } catch (_) {
    return { changed: false, value }; // unreadable — surfaces at connect time
  }
}

module.exports = { init, encrypt, decrypt, isEncrypted, migrateValue, getSigningKey };
