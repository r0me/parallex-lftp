'use strict';

const express = require('express');
const path = require('path');
const { decrypt } = require('../secretStore');

// Enqueue/list/cancel transfers. Each job runs as its own short-lived
// lftp process (see transferManager); progress streams over WebSocket.
module.exports = function transfersRouter(transferManager, sitesStore, LOCAL_ROOT) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(transferManager.list());
  });

  router.post('/', (req, res) => {
    const { direction, siteId, remotePath, localPath, size } = req.body || {};
    if (!['download', 'upload'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be download or upload' });
    }
    if (!remotePath || !localPath) {
      return res.status(400).json({ error: 'remotePath and localPath are required' });
    }
    const site = sitesStore.read().sites.find((s) => s.id === siteId);
    if (!site) return res.status(404).json({ error: 'site not found' });

    // Local side is virtual (relative to LOCAL_ROOT), same sandbox rule
    // as the local browsing routes.
    const rel = String(localPath).replace(/^\/+/, '');
    const absLocal = path.resolve(LOCAL_ROOT, rel);
    if (absLocal !== LOCAL_ROOT && !absLocal.startsWith(LOCAL_ROOT + path.sep)) {
      return res.status(400).json({ error: 'localPath escapes local root' });
    }

    let password;
    try {
      password = decrypt(site.password); // in memory only, for the lftp process
    } catch (err) {
      return res.status(err.status || 409).json({ error: err.message, code: err.code });
    }
    const job = transferManager.enqueue({
      direction,
      site: { ...site, password },
      remotePath,
      localPath: absLocal,
      size: Number(size) || 0,
    });
    res.status(201).json(job);
  });

  router.post('/:id/cancel', (req, res) => {
    const ok = transferManager.cancel(req.params.id);
    if (!ok) return res.status(404).json({ error: 'job not found or not cancellable' });
    res.json({ ok: true });
  });

  router.post('/clear-finished', (_req, res) => {
    transferManager.clearFinished();
    res.json({ ok: true });
  });

  return router;
};
