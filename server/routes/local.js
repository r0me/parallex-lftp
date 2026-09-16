'use strict';

const express = require('express');
const fs = require('fs/promises');
const path = require('path');

// Local fs browsing, sandboxed under LOCAL_ROOT (the mounted /data
// volume — the app runs headless in a container and can only see what's
// mounted in). Every incoming path is resolved and must stay inside root.
module.exports = function localRouter(LOCAL_ROOT) {
  const router = express.Router();

  // Resolve a client-supplied path (treated as relative to LOCAL_ROOT)
  // and refuse anything that escapes the sandbox.
  function resolveSafe(p) {
    const rel = String(p || '/').replace(/^\/+/, '');
    const abs = path.resolve(LOCAL_ROOT, rel);
    if (abs !== LOCAL_ROOT && !abs.startsWith(LOCAL_ROOT + path.sep)) {
      const err = new Error('path escapes local root');
      err.status = 400;
      throw err;
    }
    return abs;
  }

  const toVirtual = (abs) => '/' + path.relative(LOCAL_ROOT, abs).split(path.sep).join('/');

  router.get('/list', async (req, res, next) => {
    try {
      const abs = resolveSafe(req.query.path);
      const names = await fs.readdir(abs);
      const entries = [];
      for (const name of names) {
        try {
          const st = await fs.stat(path.join(abs, name));
          entries.push({
            name,
            type: st.isDirectory() ? 'dir' : 'file',
            size: st.size,
            mtime: st.mtime.toISOString().slice(0, 19).replace('T', ' '),
          });
        } catch (_) {
          // unreadable entry (broken symlink etc.) — skip
        }
      }
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
      );
      res.json({ path: toVirtual(abs) === '/.' ? '/' : toVirtual(abs), entries });
    } catch (err) {
      next(err);
    }
  });

  router.post('/mkdir', async (req, res, next) => {
    try {
      const abs = resolveSafe(req.body.path);
      await fs.mkdir(abs, { recursive: true });
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/delete', async (req, res, next) => {
    try {
      const abs = resolveSafe(req.body.path);
      if (abs === LOCAL_ROOT) {
        return res.status(400).json({ error: 'refusing to delete local root' });
      }
      await fs.rm(abs, { recursive: true });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/rename', async (req, res, next) => {
    try {
      const from = resolveSafe(req.body.from);
      const to = resolveSafe(req.body.to);
      await fs.rename(from, to);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
