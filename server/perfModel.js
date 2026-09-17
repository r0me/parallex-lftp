'use strict';

const path = require('path');
const { JsonStore } = require('./jsonStore');
const { log } = require('./logger');

// Adaptive segment-count learner. Treats "how many pget -n connections to
// use" as a multi-armed bandit per (site, size-bucket): each candidate n is
// an arm, the reward is measured MB/s, tracked as an EMA. We explore under-
// sampled arms first, then mostly exploit the fastest with a little ongoing
// exploration so it re-adapts when the link or server changes.
//
// Persisted to /config/perf.json:
//   { sites: { <siteId>: { <bucket>: { <n>: { count, ema, at } } } } }

const EMA_ALPHA = 0.35; // weight on the newest sample
const MIN_SAMPLES = 2; // per arm before we trust it enough to exploit
const EPSILON = 0.12; // ongoing exploration once warmed up
const MIN_SECONDS = 1.0; // ignore transfers too short to measure reliably

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Size buckets + the candidate connection counts to explore in each. Kept to
// a small neighbourhood so we never try 4 connections on a 20 GB file.
const BUCKETS = [
  { key: 'xs', max: 512 * MB, candidates: [4, 6, 8] },
  { key: 's', max: 2 * GB, candidates: [6, 8, 12] },
  { key: 'm', max: 8 * GB, candidates: [8, 12, 16] },
  { key: 'l', max: Infinity, candidates: [12, 16] },
];

let store = null;

function init(configDir) {
  store = new JsonStore(path.join(configDir, 'perf.json'), { sites: {} });
}

function bucketFor(size) {
  return BUCKETS.find((b) => size < b.max) || BUCKETS[BUCKETS.length - 1];
}

function armsFor(siteId, bucketKey) {
  const data = store.read();
  return (data.sites[siteId] && data.sites[siteId][bucketKey]) || {};
}

// Choose a connection count for this file. `prior` (the static size curve)
// seeds the choice before any data exists. Returns { n, explore, reason }.
function pickN(siteId, size, prior) {
  if (!store || !siteId) return { n: prior, explore: false, reason: 'no-model' };
  const bucket = bucketFor(size);
  const arms = armsFor(siteId, bucket.key);
  const candidates = bucket.candidates;

  // Explore the least-sampled arm until every candidate has MIN_SAMPLES.
  const undersampled = candidates
    .map((n) => ({ n, count: arms[n] ? arms[n].count : 0 }))
    .filter((a) => a.count < MIN_SAMPLES)
    .sort((a, b) => a.count - b.count);
  if (undersampled.length) {
    // bias the very first pick toward the prior so early transfers aren't wild
    const seed = candidates.includes(prior) && !arms[prior] ? prior : undersampled[0].n;
    return { n: seed, explore: true, reason: 'warmup' };
  }

  // Warmed up: exploit the fastest EMA, explore occasionally.
  const best = candidates
    .map((n) => ({ n, ema: arms[n] ? arms[n].ema : 0 }))
    .sort((a, b) => b.ema - a.ema)[0];
  if (Math.random() < EPSILON) {
    const others = candidates.filter((n) => n !== best.n);
    const n = others[Math.floor(Math.random() * others.length)];
    return { n, explore: true, reason: 'epsilon' };
  }
  return { n: best.n, explore: false, reason: 'exploit' };
}

// Record a completed transfer's measured throughput for its (site, size, n).
function record(siteId, size, n, bytes, seconds) {
  if (!store || !siteId || !n || n < 1) return;
  if (!(seconds > MIN_SECONDS) || !(bytes > 0)) return;
  const mbps = bytes / MB / seconds;
  const bucket = bucketFor(size);
  const data = store.read();
  const site = (data.sites[siteId] = data.sites[siteId] || {});
  const b = (site[bucket.key] = site[bucket.key] || {});
  const arm = (b[n] = b[n] || { count: 0, ema: 0 });
  arm.count += 1;
  arm.ema = arm.ema === 0 ? mbps : EMA_ALPHA * mbps + (1 - EMA_ALPHA) * arm.ema;
  arm.at = new Date().toISOString();
  store.write(data);
  log('perf', `site ${siteId} bucket ${bucket.key} n=${n}: ${mbps.toFixed(1)} MB/s (ema ${arm.ema.toFixed(1)}, ${arm.count} samples)`);
}

module.exports = { init, pickN, record, bucketFor, BUCKETS };
