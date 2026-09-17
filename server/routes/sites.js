'use strict';

const express = require('express');
const crypto = require('crypto');
const { encrypt } = require('../secretStore');

// Site Manager CRUD -> /config/sites.json
// Passwords (and private keys, once key auth lands) are encrypted at rest
// via secretStore before hitting disk. Responses never include the
// password; the frontend sends `password: null` to mean "keep the stored
// one".
module.exports = function sitesRouter(store) {
  const router = express.Router();

  const publicSite = (s) => {
    const { password, privateKey, ...rest } = s;
    return { ...rest, hasPassword: Boolean(password), hasPrivateKey: Boolean(privateKey) };
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
    protocol: ['ftp', 'ftps', 'sftp', 'http', 'https'].includes(site.protocol) ? site.protocol : 'ftp',
    username: site.username || '',
    // for https/ftps: false = skip TLS cert verification (self-signed homelab)
    verifyTls: site.verifyTls === false ? false : true,
    // encrypt() is a no-op on empty and on already-encrypted values (the
    // keep-stored-password path passes the encrypted form back through)
    password: encrypt(site.password || ''),
    // authType 'key' has a spot in the schema/UI but only 'password' is
    // wired end-to-end right now; a stored key is encrypted like passwords.
    authType: site.authType === 'key' ? 'key' : 'password',
    privateKey: site.privateKey ? encrypt(site.privateKey) : null,
    remoteDir: site.remoteDir || '/',
    localDir: site.localDir || '/',
    threads: site.threads ? Number(site.threads) : null,
    segments: site.segments ? Number(site.segments) : null,
  };
}
