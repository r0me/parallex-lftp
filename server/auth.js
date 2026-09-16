'use strict';

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { JsonStore } = require('./jsonStore');
const { getSigningKey } = require('./secretStore');
const { log } = require('./logger');

// Single-user local auth. The user lives in /config/auth.json as a scrypt
// hash (never plaintext). Sessions are stateless signed cookies, so they
// survive restarts without a session store; changing the password bumps
// tokenVersion, which invalidates every previously issued cookie.
// Lockout recovery: delete /config/auth.json and restart -> first-run
// setup again (same trust boundary as the config volume itself).

const COOKIE_NAME = 'plx_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

let store = null;

function init(configDir) {
  store = new JsonStore(path.join(configDir, 'auth.json'), { user: null });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_OPTS);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(actual, expected);
}

function getUser() {
  return store.read().user;
}

function isConfigured() {
  return Boolean(getUser());
}

function createUser(username, password) {
  const user = {
    username: String(username),
    hash: hashPassword(password),
    tokenVersion: 1,
    createdAt: new Date().toISOString(),
  };
  store.write({ user });
  log('auth', `user "${user.username}" configured`);
  return user;
}

// ---- stateless session cookie -------------------------------------------

function sign(payload) {
  const mac = crypto.createHmac('sha256', getSigningKey()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function issueToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ u: user.username, v: user.tokenVersion, exp: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  return sign(payload);
}

function verifyToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const expected = sign(payload);
  if (
    expected.length !== token.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))
  ) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  const user = getUser();
  if (!user) return null;
  if (data.u !== user.username || data.v !== user.tokenVersion) return null;
  if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
  return { username: user.username };
}

function tokenFromCookieHeader(header) {
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Works for both express requests and raw upgrade requests (WebSocket).
function verifyRequest(req) {
  return verifyToken(tokenFromCookieHeader(req.headers && req.headers.cookie));
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ---- brute-force damping -------------------------------------------------

const failures = new Map(); // ip -> { count, last }

function failureDelay(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (Date.now() - f.last > 15 * 60 * 1000) {
    failures.delete(ip);
    return 0;
  }
  return f.count >= 3 ? 500 * Math.min(f.count, 20) : 0;
}

function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, last: 0 };
  f.count++;
  f.last = Date.now();
  failures.set(ip, f);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- middleware & routes -------------------------------------------------

function requireAuth(req, res, next) {
  const session = verifyRequest(req);
  if (!session) return res.status(401).json({ error: 'not authenticated', code: 'AUTH_REQUIRED' });
  req.session = session;
  next();
}

function router() {
  const r = express.Router();

  r.get('/status', (req, res) => {
    const session = verifyRequest(req);
    res.json({
      configured: isConfigured(),
      authenticated: Boolean(session),
      username: session ? session.username : null,
    });
  });

  r.post('/setup', (req, res) => {
    if (isConfigured()) return res.status(409).json({ error: 'already configured — log in instead' });
    const { username, password } = req.body || {};
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'username required' });
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const user = createUser(String(username).trim(), String(password));
    setSessionCookie(res, issueToken(user));
    res.status(201).json({ ok: true, username: user.username });
  });

  r.post('/login', async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const delay = failureDelay(ip);
    if (delay) await sleep(delay);
    const user = getUser();
    const { username, password } = req.body || {};
    if (!user || username !== user.username || !verifyPassword(String(password || ''), user.hash)) {
      recordFailure(ip);
      log('auth', `failed login attempt from ${ip}`);
      return res.status(401).json({ error: 'invalid username or password' });
    }
    failures.delete(ip);
    setSessionCookie(res, issueToken(user));
    log('auth', `"${user.username}" logged in from ${ip}`);
    res.json({ ok: true, username: user.username });
  });

  r.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.post('/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const user = getUser();
    if (!verifyPassword(String(currentPassword || ''), user.hash)) {
      return res.status(401).json({ error: 'current password is incorrect' });
    }
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'new password must be at least 8 characters' });
    }
    const updated = {
      ...user,
      hash: hashPassword(String(newPassword)),
      tokenVersion: (user.tokenVersion || 1) + 1, // invalidates old cookies
    };
    store.write({ user: updated });
    setSessionCookie(res, issueToken(updated));
    log('auth', `password changed for "${user.username}"`);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { init, router, requireAuth, verifyRequest, isConfigured, createUser };
