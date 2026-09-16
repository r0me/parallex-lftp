'use strict';

const express = require('express');
const crypto = require('crypto');

// Site Manager CRUD -> /config/sites.json
// NOTE: passwords are stored in plaintext in that file — homelab tradeoff,
// documented in the README. Responses never include the password; the
// frontend sends `password: null` to mean "keep the stored one".
module.exports = function sitesRouter(store) {
  const router = express.Router();

  const publicSite = (s) => {
    const { password, ...rest } = s;
    return { ...rest, hasPassword: Boolean(password) };
  };

  router.get('/', (_req, res) => {
    res.json(store.read().sites.map(publicSite));
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.host) {
      return res.status(400).json({ error: 'name and host are required' });
    }
    const data = store.read();
    const site = normalize({ ...body, id: crypto.randomUUID() });
    data.sites.push(site);
    store.write(data);
    res.status(201).json(publicSite(site));
  });

  router.put('/:id', (req, res) => {
    const data = store.read();
    const idx = data.sites.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'site not found' });
    const existing = data.sites[idx];
    const body = req.body || {};
    const site = normalize({
      ...existing,
      ...body,
      id: existing.id,
      // null/undefined password means keep the stored one
      password: body.password == null || body.password === '' ? existing.password : body.password,
    });
    data.sites[idx] = site;
    store.write(data);
    res.json(publicSite(site));
  });

  router.delete('/:id', (req, res) => {
    const data = store.read();
    const before = data.sites.length;
    data.sites = data.sites.filter((s) => s.id !== req.params.id);
    if (data.sites.length === before) return res.status(404).json({ error: 'site not found' });
    store.write(data);
    res.status(204).end();
  });

  return router;
};

function normalize(site) {
  return {
    id: site.id,
    name: String(site.name),
    host: String(site.host),
    port: site.port ? Number(site.port) : null,
    protocol: ['ftp', 'ftps', 'sftp'].includes(site.protocol) ? site.protocol : 'ftp',
    username: site.username || '',
    password: site.password || '',
    // authType 'key' has a spot in the schema/UI but only 'password' is
    // wired end-to-end right now.
    authType: site.authType === 'key' ? 'key' : 'password',
    remoteDir: site.remoteDir || '/',
    localDir: site.localDir || '/',
    threads: site.threads ? Number(site.threads) : null,
    segments: site.segments ? Number(site.segments) : null,
  };
}
