'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const { JsonStore } = require('./jsonStore');
const { SessionManager } = require('./sessionManager');
const { TransferManager } = require('./transferManager');
const { log, redact } = require('./logger');

const PORT = Number(process.env.PORT) || 7609;
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const LOCAL_ROOT = path.resolve(process.env.LOCAL_ROOT || '/data');

// HOME points at the persistent /config volume so lftp/ssh state
// (known_hosts via trust-on-first-use) survives container rebuilds.
process.env.LFTP_HOME = CONFIG_DIR;
process.env.HOME = CONFIG_DIR;
for (const dir of [CONFIG_DIR, path.join(CONFIG_DIR, '.ssh'), LOCAL_ROOT]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log('boot', `could not create ${dir}: ${err.message}`);
  }
}
try {
  fs.chmodSync(path.join(CONFIG_DIR, '.ssh'), 0o700);
} catch (_) { /* best effort */ }

const secretStore = require('./secretStore');
secretStore.init(CONFIG_DIR);

const sitesStore = new JsonStore(path.join(CONFIG_DIR, 'sites.json'), { sites: [] });

// One-time migration: encrypt any plaintext credentials from older
// versions, and re-encrypt keyfile-encrypted values with PARALLEX_SECRET
// once one is set. Unreadable values are left alone and surface as a
// clear 409 at connect time.
{
  const data = sitesStore.read();
  let migrated = 0;
  for (const site of data.sites) {
    for (const field of ['password', 'privateKey']) {
      if (site[field] == null) continue;
      const r = secretStore.migrateValue(site[field]);
      if (r.changed) {
        site[field] = r.value;
        migrated++;
      }
    }
  }
  if (migrated > 0) {
    sitesStore.write(data);
    log('secrets', `encrypted ${migrated} stored credential(s) in sites.json`);
  }
}
const settingsStore = new JsonStore(path.join(CONFIG_DIR, 'settings.json'), {
  theme: 'amber',
  threads: 2,
  segments: 4,
  segmentMinBytes: 1024 * 1024,
  bandwidthLimitKBps: 0,
});

const auth = require('./auth');
auth.init(CONFIG_DIR);

// Optional env seed: AUTH_USERNAME/AUTH_PASSWORD create the user at boot
// when none is configured yet (the values are hashed, never stored).
if (!auth.isConfigured() && process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD) {
  if (process.env.AUTH_PASSWORD.length < 8) {
    log('auth', 'AUTH_PASSWORD too short (min 8 chars) — ignoring env seed');
  } else {
    auth.createUser(process.env.AUTH_USERNAME, process.env.AUTH_PASSWORD);
    log('auth', 'user seeded from AUTH_USERNAME/AUTH_PASSWORD env');
  }
}

const sessionManager = new SessionManager();
const transferManager = new TransferManager(() => settingsStore.read());

const app = express();
app.use(express.json());

// Request logging — every API hit, with redaction just in case.
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) log('http', `${req.method} ${redact(req.originalUrl)}`);
  next();
});

// Auth endpoints are open (login has to be reachable); everything else
// under /api requires a valid session cookie.
app.use('/api/auth', auth.router());
app.use('/api', auth.requireAuth);

app.use('/api/sites', require('./routes/sites')(sitesStore));
app.use('/api/settings', require('./routes/settings')(settingsStore));
app.use('/api/local', require('./routes/local')(LOCAL_ROOT));
app.use('/api/remote', require('./routes/remote')(sessionManager, sitesStore, settingsStore));
app.use('/api/transfers', require('./routes/transfers')(transferManager, sitesStore, LOCAL_ROOT));

// no-cache = always revalidate (ETag 304s keep it cheap), so browsers
// never serve stale CSS/JS after an image rebuild
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Error handler — lftp errors carry code/detail; everything is redacted.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.lftp ? 502 : 500);
  log('http', `ERROR ${req.method} ${req.originalUrl}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
  res.status(status).json({
    error: redact(err.message),
    code: err.code || undefined,
    detail: err.detail ? redact(err.detail) : undefined,
  });
});

const server = http.createServer(app);

// WebSocket broadcast: transfer progress fans out to every connected
// client. Single-user tool — no auth boundary between clients.
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  if (!auth.verifyRequest(req)) {
    log('ws', 'rejected unauthenticated websocket client');
    ws.close(4401, 'authentication required');
    return;
  }
  log('ws', `client connected (${wss.clients.size} total)`);
  ws.send(JSON.stringify({ type: 'transfers', jobs: transferManager.list() }));
  ws.on('close', () => log('ws', `client disconnected (${wss.clients.size} total)`));
});
transferManager.on('update', (job) => {
  const msg = JSON.stringify({ type: 'transfer', job });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

server.listen(PORT, () => {
  log('boot', `parallex-lftp listening on :${PORT} (local root ${LOCAL_ROOT}, config ${CONFIG_DIR})`);
});

process.on('SIGTERM', () => {
  log('boot', 'SIGTERM — closing sessions');
  sessionManager.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
