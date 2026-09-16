'use strict';

const express = require('express');

// Transfer settings -> /config/settings.json
module.exports = function settingsRouter(store) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(store.read());
  });

  router.put('/', (req, res) => {
    const body = req.body || {};
    const current = store.read();
    const theme = body.theme ?? current.theme;
    const next = {
      theme: ['amber', 'green', 'blue'].includes(theme) ? theme : 'amber',
      threads: clamp(body.threads ?? current.threads, 1, 16),
      segments: clamp(body.segments ?? current.segments, 1, 16),
      segmentMinBytes: Math.max(0, Number(body.segmentMinBytes ?? current.segmentMinBytes) || 0),
      bandwidthLimitKBps: Math.max(0, Number(body.bandwidthLimitKBps ?? current.bandwidthLimitKBps) || 0),
    };
    store.write(next);
    res.json(next);
  });

  return router;
};

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}
