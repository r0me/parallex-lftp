'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { quote } = require('./lftpSession');
const { log, redact } = require('./logger');

// lftp only renders its progress meter when stdout is a terminal — with
// piped stdio it prints nothing at all, so progress stays blank. Run each
// transfer under a pty via `script` (bsdutils, present on debian-slim)
// when available; fall back to a plain pipe (no live progress) otherwise.
const HAS_SCRIPT = (() => {
  const r = spawnSync('script', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
})();

// Meter lines look like:
//   `file.bin' at 52428800 (25%) 10.4M/s eta:36s [Receiving data]
//   `file.bin', got 52428800 of 209715200 (25%) 10.4M/s eta:36s
// NOTE: the meter text format can vary by lftp version. If live progress
// stops updating after a base-image change, check `docker logs` for the
// actual meter line and adjust this regex.
const PROGRESS_RE =
  /(?:\bat|got)\s+(\d+)(?:\s+of\s+\d+)?\s+\((\d+)%\)(?:\s+([\d.]+\s*[KMGT]?i?[Bb]?\/s))?(?:.*?eta:?\s*([\dhms:]+))?/i;

// Segment/chunk status lines like `\chunk at 1048576` — activity noise,
// not overall percent.
const SEGMENT_RE = /^\\(?:chunk|transfer)\b/i;

// pty output can carry terminal escape sequences — strip before parsing.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

// `mirror --verbose` action lines: `Transferring file `sub/x.mkv'`,
// `Making directory `sub'`, `Removing old file `y'`, etc.
const MIRROR_XFER_RE = /Transferring file `(.+?)'/;
const MIRROR_ACTION_RE = /^(Transferring file|Making directory|mkdir|Removing old (?:file|directory)|chmod|Skipping) /i;

/**
 * Runs each transfer as its own short-lived lftp process so long transfers
 * never block the interactive browsing session and each job can be killed
 * independently. Queue is limited to `threads` concurrent jobs.
 */
class TransferManager extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings; // () => current global settings
    this.jobs = new Map(); // id -> job
    this.queue = [];
    this.running = 0;
  }

  enqueue({ direction, site, remotePath, localPath, size = 0, isDir = false, settings = {} }) {
    const global = this.getSettings();
    const effective = {
      threads: settings.threads || site.threads || global.threads || 2,
      segments: settings.segments || site.segments || global.segments || 4,
      segmentMinBytes: global.segmentMinBytes ?? 1024 * 1024,
      bandwidthLimitKBps: global.bandwidthLimitKBps || 0,
    };
    const job = {
      id: crypto.randomUUID(),
      direction, // 'download' | 'upload'
      isDir, // folder transfer via `mirror` instead of a single-file get/put
      site: { name: site.name, host: site.host, port: site.port, protocol: site.protocol },
      _site: site, // full site incl. credentials; never serialized
      remotePath,
      localPath,
      size,
      // folders use mirror (its own --parallel/--use-pget-n); only a single
      // file download segments. lftp has no pput, so uploads never segment.
      segments:
        !isDir && direction === 'download' && size >= effective.segmentMinBytes
          ? effective.segments
          : 1,
      effective,
      status: 'queued', // queued | running | done | error | cancelled
      percent: 0,
      bytes: 0,
      speed: null,
      eta: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      proc: null,
      segmentProgress: null, // per-segment 0..1, from the pget status file
      currentFile: null, // folder jobs: file mirror is currently on
      filesTransferred: 0, // folder jobs: count of files mirror has started
      _statusTimer: null,
      _sizeTimer: null, // folder downloads: polls the local dest for progress
      _lastSample: null, // { bytes, t } for folder speed/ETA
      _logTail: [], // folder jobs: recent verbose mirror lines (error context)
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    log('transfer', `queued ${direction} ${isDir ? 'folder ' : ''}${remotePath} <-> ${localPath} (${job.segments} segment(s))`);
    this._broadcast(job);
    this._drain();
    return this.describe(job);
  }

  _drain() {
    const threads = Math.max(1, this.getSettings().threads || 2);
    while (this.running < threads && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job.status !== 'queued') continue;
      this._start(job);
    }
  }

  _start(job) {
    this.running++;
    job.status = 'running';
    job.startedAt = Date.now();

    const site = job._site;
    const scheme = { ftp: 'ftp', ftps: 'ftp', sftp: 'sftp' }[site.protocol] || 'ftp';
    const url = `${scheme}://${site.host}${site.port ? `:${site.port}` : ''}`;
    const user = site.username || 'anonymous';
    const pass = site.password || '';

    const settingsCmds = [
      'set cmd:interactive no',
      'set net:max-retries 2',
      'set net:timeout 15',
      'set sftp:auto-confirm yes',
      'set xfer:eta-period 3',
      // frequent pget status-file writes drive the per-segment progress UI
      'set pget:save-status 2',
    ];
    if (site.protocol === 'ftps') {
      settingsCmds.push('set ftp:ssl-force yes', 'set ftp:ssl-protect-data yes');
    }
    if (site.protocol === 'sftp') {
      // lftp's SFTP defaults (32K blocks, 16 packets in flight) cap each
      // connection at a few MB/s; these take it to line speed
      settingsCmds.push(
        'set sftp:size-read 131072',
        'set sftp:size-write 131072',
        'set sftp:max-packets-in-flight 64'
      );
    }
    if (job.effective.bandwidthLimitKBps > 0) {
      settingsCmds.push(`set net:limit-rate ${job.effective.bandwidthLimitKBps * 1024}`);
    }

    const par = Math.max(1, job.effective.threads);
    let xfer;
    if (job.isDir) {
      // Recursive folder transfer. `mirror` walks the tree; --parallel runs
      // several files at once and (download only) --use-pget-n segments each
      // large file. -c continues a partial mirror on retry.
      // --verbose makes mirror announce each file/dir it touches; we surface
      // those lines (current file, running count) in the UI and server log.
      if (job.direction === 'download') {
        xfer = `mirror -c --verbose --parallel=${par} --use-pget-n=${job.effective.segments} ${quote(job.remotePath)} ${quote(job.localPath)}`;
      } else {
        // -R = reverse (upload); no pget on the way up
        xfer = `mirror -R -c --verbose --parallel=${par} ${quote(job.localPath)} ${quote(job.remotePath)}`;
      }
    } else if (job.direction === 'download') {
      xfer =
        job.segments > 1
          ? `pget -n ${job.segments} ${quote(job.remotePath)} -o ${quote(job.localPath)}`
          : `get ${quote(job.remotePath)} -o ${quote(job.localPath)}`;
    } else {
      // lftp has no pput; single-file uploads are always single-stream
      xfer = `put ${quote(job.localPath)} -o ${quote(job.remotePath)}`;
    }

    const script = [
      ...settingsCmds,
      // Credentials over stdin, never CLI args (keeps them out of `ps`).
      `open -u ${quote(user)},${quote(pass)} ${quote(url)}`,
      xfer,
      'exit',
    ].join('\n');

    log('transfer', `[${job.id}] starting: ${xfer}`);
    const env = {
      ...process.env,
      HOME: process.env.LFTP_HOME || process.env.HOME || '/config',
      TERM: 'dumb', // keep the pty meter plain \r rewrites, not cursor escapes
    };
    // Under `script`, lftp sees a terminal and renders its progress meter.
    // stty -echo stops the pty echoing our stdin (which carries credentials)
    // back into the output stream.
    const proc = HAS_SCRIPT
      ? spawn('script', ['-qefc', 'stty -echo 2>/dev/null; exec lftp', '/dev/null'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn('lftp', [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    job.proc = proc;
    // Small delay so stty -echo takes effect before credentials hit the pty.
    setTimeout(() => {
      try {
        proc.stdin.write(script + '\n');
        proc.stdin.end();
      } catch (_) { /* process already died; exit handler reports it */ }
    }, HAS_SCRIPT ? 75 : 0);

    let errText = '';
    const onData = (d) => {
      const text = d.toString().replace(ANSI_RE, '');
      // Meter lines end with \r; split on both.
      for (const line of text.split(/[\r\n]+/)) {
        if (!line.trim()) continue;

        if (job.isDir) {
          // Folder percent/bytes come from du + the local-dir poll, NOT from
          // mirror's per-file `got N of M (P%)` meters — those would spike
          // the folder percent to a single file's progress. Only read the
          // verbose action lines here for the "current file" display.
          const xm = MIRROR_XFER_RE.exec(line);
          if (xm) {
            job.currentFile = path.basename(xm[1]);
            job.filesTransferred++;
          }
          if (MIRROR_ACTION_RE.test(line.trim())) {
            log('transfer', `[${job.id}] ${line.trim()}`);
            job._logTail.push(line.trim());
            if (job._logTail.length > 15) job._logTail.shift();
            if (xm) this._broadcast(job);
          } else if (!PROGRESS_RE.test(line) && !SEGMENT_RE.test(line)) {
            errText += line + '\n';
            if (errText.length > 8192) errText = errText.slice(-8192);
          }
          continue;
        }

        const m = PROGRESS_RE.exec(line);
        if (m) {
          // monotonic: the pty meter can lag the pget status file
          job.bytes = Math.max(job.bytes, Number(m[1]));
          job.percent = Math.max(job.percent, Number(m[2]));
          if (m[3]) job.speed = m[3];
          if (m[4]) job.eta = m[4];
          this._broadcast(job);
        } else if (!SEGMENT_RE.test(line)) {
          errText += line + '\n';
          if (errText.length > 8192) errText = errText.slice(-8192);
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    // pget writes `<file>.lftp-pget-status` (pos/limit per chunk) while it
    // runs — the only source of true per-segment progress, since the tty
    // meter is a single aggregate line.
    if (!job.isDir && job.direction === 'download' && job.segments > 1) {
      job._statusTimer = setInterval(() => this._readPgetStatus(job), 1000);
    }

    // Folder download: mirror emits per-file meters, not one aggregate, so
    // measure the local destination as it fills. The remote total is fetched
    // async (a `du`) so percent can show once known; until then it's bytes +
    // speed only. Kicked off after a beat so the dest dir exists.
    if (job.isDir && job.direction === 'download') {
      setTimeout(() => this._measureRemoteDir(job), 300);
      job._sizeTimer = setInterval(() => this._pollDirSize(job), 1000);
    }

    proc.on('exit', (code) => {
      this.running--;
      job.proc = null;
      job.finishedAt = Date.now();
      if (job._statusTimer) {
        clearInterval(job._statusTimer);
        job._statusTimer = null;
      }
      if (job._sizeTimer) {
        clearInterval(job._sizeTimer);
        job._sizeTimer = null;
      }
      if (code === 0) job.segmentProgress = null; // bar renders full via percent
      if (job.status === 'cancelled') {
        // already marked by cancel()
      } else if (code === 0) {
        job.status = 'done';
        job.percent = 100;
      } else {
        job.status = 'error';
        job.error = redact(errText.trim().split('\n').slice(-3).join(' ')) || `lftp exited with code ${code}`;
        log('transfer', `[${job.id}] failed: ${job.error}`);
      }
      this._broadcast(job);
      this._drain();
    });
    proc.on('error', (err) => {
      job.status = 'error';
      job.error = err.message;
      this._broadcast(job);
    });
    this._broadcast(job);
  }

  // Parse `<file>.lftp-pget-status`:
  //   size=157286400
  //   0.pos=524288    <- chunk's current absolute offset
  //   0.limit=39321600 <- chunk's end offset
  // Chunks are contiguous, so chunk i starts where chunk i-1 ends (chunk 0
  // at 0). A chunk missing from the file is finished.
  _readPgetStatus(job) {
    fs.readFile(job.localPath + '.lftp-pget-status', 'utf8', (err, text) => {
      if (err || !text || job.status !== 'running') return;
      const chunks = new Map();
      let size = 0;
      for (const line of text.split('\n')) {
        let m = /^size=(\d+)/.exec(line);
        if (m) { size = Number(m[1]); continue; }
        m = /^(\d+)\.(pos|limit)=(\d+)/.exec(line);
        if (m) {
          const c = chunks.get(m[1]) || {};
          c[m[2]] = Number(m[3]);
          chunks.set(m[1], c);
        }
      }
      if (!size || chunks.size === 0) return;

      const progress = new Array(job.segments).fill(1); // absent chunk = done
      let doneBytes = size;
      for (const [key, c] of chunks) {
        if (c.pos == null || c.limit == null) continue;
        const idx = Number(key);
        doneBytes -= Math.max(0, c.limit - c.pos);
        // chunk start = previous chunk's limit (chunks are contiguous);
        // if the predecessor already finished and vanished, approximate
        const start = idx === 0 ? 0 : chunks.get(String(idx - 1))?.limit;
        const frac =
          start != null && c.limit > start
            ? (c.pos - start) / (c.limit - start)
            : c.pos / c.limit;
        if (idx < job.segments) progress[idx] = Math.min(1, Math.max(0, frac));
      }
      job.segmentProgress = progress;
      job.bytes = Math.max(job.bytes, doneBytes);
      job.percent = Math.max(job.percent, Math.min(99, Math.floor((doneBytes / size) * 100)));
      this._broadcast(job);
    });
  }

  // Folder download progress: sum the local destination tree and derive
  // speed/ETA from the byte delta. Percent needs the remote total, filled in
  // asynchronously by _measureRemoteDir; until then percent stays 0.
  _pollDirSize(job) {
    if (job.status !== 'running') return;
    dirSizeBytes(job.localPath, (bytes) => {
      if (job.status !== 'running') return;
      const now = Date.now();
      job.bytes = Math.max(job.bytes, bytes);
      if (job._lastSample) {
        const dt = (now - job._lastSample.t) / 1000;
        const db = job.bytes - job._lastSample.bytes;
        if (dt >= 0.5 && db >= 0) {
          job.speed = formatSpeed(db / dt);
          if (job.size > 0 && db > 0) {
            const remaining = Math.max(0, job.size - job.bytes);
            job.eta = formatEta(remaining / (db / dt));
          }
        }
      }
      job._lastSample = { bytes: job.bytes, t: now };
      if (job.size > 0) {
        job.percent = Math.max(job.percent, Math.min(99, Math.floor((job.bytes / job.size) * 100)));
      }
      this._broadcast(job);
    });
  }

  // Query the remote folder's total byte size in a throwaway lftp process so
  // percent can be shown. Best-effort: on any failure percent just stays
  // indeterminate (bytes + speed still show). Runs alongside the mirror.
  _measureRemoteDir(job) {
    if (job.status !== 'running') return;
    const site = job._site;
    const scheme = { ftp: 'ftp', ftps: 'ftp', sftp: 'sftp' }[site.protocol] || 'ftp';
    const url = `${scheme}://${site.host}${site.port ? `:${site.port}` : ''}`;
    const script = [
      'set cmd:interactive no',
      'set sftp:auto-confirm yes',
      'set net:max-retries 1',
      'set net:timeout 20',
      `open -u ${quote(site.username || 'anonymous')},${quote(site.password || '')} ${quote(url)}`,
      `du -bs ${quote(job.remotePath)}`,
      'exit',
    ].join('\n');
    const proc = spawn('lftp', [], {
      env: { ...process.env, HOME: process.env.LFTP_HOME || process.env.HOME || '/config' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => {});
    proc.on('exit', () => {
      // du prints `<bytes>\t<path>`; take the first integer on a data line.
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s/.exec(line);
        if (m) {
          const total = Number(m[1]);
          if (total > 0 && job.status === 'running') {
            job.size = total;
            log('transfer', `[${job.id}] remote folder size ${total} bytes`);
            this._broadcast(job);
          }
          return;
        }
      }
    });
    proc.stdin.write(script + '\n');
    proc.stdin.end();
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      this._broadcast(job);
      return true;
    }
    if (job.status === 'running' && job.proc) {
      job.status = 'cancelled';
      job.proc.kill('SIGTERM');
      setTimeout(() => {
        if (job.proc && job.proc.exitCode === null) job.proc.kill('SIGKILL');
      }, 3000).unref();
      this._broadcast(job);
      return true;
    }
    return false;
  }

  clearFinished() {
    for (const [id, job] of this.jobs) {
      if (['done', 'error', 'cancelled'].includes(job.status)) this.jobs.delete(id);
    }
  }

  list() {
    return [...this.jobs.values()].map((j) => this.describe(j));
  }

  describe(job) {
    return {
      id: job.id,
      direction: job.direction,
      isDir: job.isDir,
      site: job.site,
      remotePath: job.remotePath,
      localPath: job.localPath,
      name: path.basename(job.direction === 'download' ? job.remotePath : job.localPath),
      size: job.size,
      segments: job.segments,
      status: job.status,
      percent: job.percent,
      bytes: job.bytes,
      segmentProgress: job.segmentProgress,
      currentFile: job.currentFile,
      filesTransferred: job.filesTransferred,
      speed: job.speed,
      eta: job.eta,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  _broadcast(job) {
    this.emit('update', this.describe(job));
  }
}

// Recursively sum file sizes under `root` (async, error-tolerant). Used to
// track how much of a folder download has landed locally.
function dirSizeBytes(root, cb) {
  let total = 0;
  let pending = 1;
  const done = () => { if (--pending === 0) cb(total); };
  const walk = (dir) => {
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) return done();
      pending += entries.length;
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else fs.stat(full, (e2, st) => { if (!e2 && st.isFile()) total += st.size; done(); });
      }
      done();
    });
  };
  walk(root);
}

function formatSpeed(bytesPerSec) {
  const u = ['B', 'K', 'M', 'G', 'T'];
  let v = bytesPerSec, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${u[i]}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

module.exports = { TransferManager, PROGRESS_RE };
