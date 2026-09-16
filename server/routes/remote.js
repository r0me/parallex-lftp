'use strict';

const express = require('express');
const { log } = require('../logger');

// Remote browsing/ops via sessionManager. Connect creates a persistent
// lftp session (validated with a real cd -> pwd -> cls round-trip inside
// LftpSession.connect); everything else addresses it by session id.
module.exports = function remoteRouter(sessionManager, sitesStore, settingsStore) {
  const router = express.Router();

  router.post('/connect', async (req, res, next) => {
    try {
      const { siteId } = req.body || {};
      const site = sitesStore.read().sites.find((s) => s.id === siteId);
      if (!site) return res.status(404).json({ error: 'site not found' });
      if (site.authType === 'key') {
        return res.status(400).json({ error: 'SSH key auth is not wired up yet — use password auth' });
      }
      log('remote', `connect requested for site "${site.name}"`);
      const { info } = await sessionManager.connect(site, settingsStore.read());
      res.json({ sessionId: info.id, cwd: info.cwd, site: { id: site.id, name: site.name } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/disconnect', (req, res) => {
    const ok = sessionManager.disconnect(req.body?.sessionId);
    res.json({ ok });
  });

  function withSession(req, res) {
    const session = sessionManager.get(req.body?.sessionId || req.query?.sessionId);
    if (!session) {
      res.status(410).json({ error: 'session not found or expired — reconnect' });
      return null;
    }
    return session;
  }

  router.get('/list', async (req, res, next) => {
    const session = withSession(req, res);
    if (!session) return;
    try {
      const dir = req.query.path || '.';
      const entries = await session.list(dir);
      res.json({ path: session.cwd, entries });
    } catch (err) {
      next(err);
    }
  });

  router.post('/cd', async (req, res, next) => {
    const session = withSession(req, res);
    if (!session) return;
    try {
      const cwd = await session.chdir(req.body.path);
      const entries = await session.list('.');
      res.json({ path: cwd, entries });
    } catch (err) {
      next(err);
    }
  });

  router.post('/mkdir', async (req, res, next) => {
    const session = withSession(req, res);
    if (!session) return;
    try {
      await session.mkdir(req.body.path);
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/delete', async (req, res, next) => {
    const session = withSession(req, res);
    if (!session) return;
    try {
      await session.remove(req.body.path, Boolean(req.body.isDir));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/rename', async (req, res, next) => {
    const session = withSession(req, res);
    if (!session) return;
    try {
      await session.rename(req.body.from, req.body.to);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
