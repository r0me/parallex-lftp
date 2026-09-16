'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
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

  enqueue({ direction, site, remotePath, localPath, size = 0, settings = {} }) {
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
      site: { name: site.name, host: site.host, port: site.port, protocol: site.protocol },
      _site: site, // full site incl. credentials; never serialized
      remotePath,
      localPath,
      size,
      // lftp has no pput — only downloads can be segmented
      segments:
        direction === 'download' && size >= effective.segmentMinBytes ? effective.segments : 1,
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
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    log('transfer', `queued ${direction} ${remotePath} <-> ${localPath} (${job.segments} segment(s))`);
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
    ];
    if (site.protocol === 'ftps') {
      settingsCmds.push('set ftp:ssl-force yes', 'set ftp:ssl-protect-data yes');
    }
    if (job.effective.bandwidthLimitKBps > 0) {
      settingsCmds.push(`set net:limit-rate ${job.effective.bandwidthLimitKBps * 1024}`);
    }

    let xfer;
    if (job.direction === 'download') {
      xfer =
        job.segments > 1
          ? `pget -n ${job.segments} ${quote(job.remotePath)} -o ${quote(job.localPath)}`
          : `get ${quote(job.remotePath)} -o ${quote(job.localPath)}`;
    } else {
      // lftp has no pput; uploads are always single-stream
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
        const m = PROGRESS_RE.exec(line);
        if (m) {
          job.bytes = Number(m[1]);
          job.percent = Number(m[2]);
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

    proc.on('exit', (code) => {
      this.running--;
      job.proc = null;
      job.finishedAt = Date.now();
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
      site: job.site,
      remotePath: job.remotePath,
      localPath: job.localPath,
      name: path.basename(job.direction === 'download' ? job.remotePath : job.localPath),
      size: job.size,
      segments: job.segments,
      status: job.status,
      percent: job.percent,
      bytes: job.bytes,
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

module.exports = { TransferManager, PROGRESS_RE };
