'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { log, redact } = require('./logger');

// Known lftp failure text. lftp mostly prints errors to the same stream as
// results and exits 0, so "did the command error" has to be answered by
// matching output against these. Keep patterns lowercase; matching is
// case-insensitive.
const ERROR_PATTERNS = [
  { re: /login failed/i, code: 'AUTH', message: 'Login failed — check username/password' },
  { re: /login incorrect/i, code: 'AUTH', message: 'Login incorrect — check username/password' },
  { re: /access denied/i, code: 'AUTH', message: 'Access denied by server' },
  { re: /password.*incorrect/i, code: 'AUTH', message: 'Password incorrect' },
  { re: /permission denied/i, code: 'PERM', message: 'Permission denied' },
  { re: /host key verification failed/i, code: 'HOSTKEY', message: 'SSH host key verification failed' },
  { re: /no such file or directory/i, code: 'NOTFOUND', message: 'No such file or directory' },
  { re: /no such directory/i, code: 'NOTFOUND', message: 'No such directory' },
  { re: /not a directory/i, code: 'NOTDIR', message: 'Not a directory' },
  { re: /unrecognized option|invalid option|unknown command/i, code: 'BADCMD', message: 'lftp rejected the command (bad option)' },
  { re: /connection refused/i, code: 'CONN', message: 'Connection refused' },
  { re: /connection reset/i, code: 'CONN', message: 'Connection reset by server' },
  { re: /could not resolve|name or service not known|unknown host/i, code: 'DNS', message: 'Could not resolve hostname' },
  { re: /timed? ?out/i, code: 'TIMEOUT', message: 'Operation timed out' },
  { re: /certificate verification/i, code: 'TLS', message: 'TLS certificate verification failed' },
  { re: /fatal error/i, code: 'FATAL', message: 'lftp fatal error' },
  { re: /operation not supported/i, code: 'UNSUPPORTED', message: 'Operation not supported by server' },
  { re: /file already exists/i, code: 'EXISTS', message: 'File already exists' },
];

// Scan combined command output for a known lftp failure phrase.
// Returns { code, message, detail } or null when the output looks clean.
function detectLftpError(output) {
  if (!output) return null;
  for (const line of output.split('\n')) {
    for (const p of ERROR_PATTERNS) {
      if (p.re.test(line)) {
        return { code: p.code, message: p.message, detail: redact(line.trim()) };
      }
    }
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Persistent lftp process wrapper.
 *
 * lftp doesn't tag output with command boundaries, so every command is
 * followed by `echo <random sentinel>`; stdout is buffered until the
 * sentinel line appears and everything before it is that command's output.
 * Commands are queued and run strictly one at a time so output never
 * interleaves between commands.
 */
class LftpSession extends EventEmitter {
  constructor(site, settings = {}) {
    super();
    this.site = site;
    this.settings = settings;
    this.id = crypto.randomUUID();
    this.proc = null;
    this.buffer = '';
    this.queue = [];
    this.current = null; // { sentinel, resolve, reject, timer }
    this.connected = false;
    this.cwd = null;
    this.closed = false;
  }

  url() {
    const { protocol, host, port } = this.site;
    const scheme = { ftp: 'ftp', ftps: 'ftp', sftp: 'sftp' }[protocol] || 'ftp';
    return `${scheme}://${host}${port ? `:${port}` : ''}`;
  }

  async connect() {
    if (this.proc) throw new Error('session already started');
    const site = this.site;
    log('session', `[${this.id}] spawning lftp for site "${site.name}" (${site.protocol}://${redact(site.host)})`);

    this.proc = spawn('lftp', [], {
      env: {
        ...process.env,
        // HOME points at the persistent /config volume so the SSH
        // known_hosts store survives container rebuilds.
        HOME: process.env.LFTP_HOME || process.env.HOME || '/config',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (d) => this._onData(d.toString()));
    this.proc.stderr.on('data', (d) => this._onData(d.toString()));
    this.proc.on('exit', (code) => {
      log('session', `[${this.id}] lftp exited (code ${code})`);
      this.connected = false;
      this._failCurrent(new Error('lftp process exited'));
      this.emit('exit', code);
    });
    this.proc.on('error', (err) => {
      log('session', `[${this.id}] lftp spawn error: ${err.message}`);
      this._failCurrent(err);
    });

    // Session-level settings. sftp:auto-confirm gives trust-on-first-use
    // host keys — there's no TTY to answer the interactive prompt.
    const setup = [
      'set cmd:interactive no',
      'set net:max-retries 2',
      'set net:timeout 15',
      'set net:reconnect-interval-base 3',
      'set sftp:auto-confirm yes',
    ];
    if (site.protocol === 'ftps') {
      setup.push('set ftp:ssl-force yes', 'set ftp:ssl-protect-data yes');
    }
    for (const cmd of setup) await this.exec(cmd);

    // Credentials go over stdin via `open -u`, never as CLI args, so they
    // never appear in `ps` output.
    const user = site.username || 'anonymous';
    const pass = site.password || '';
    const openOut = await this.exec(
      `open -u ${quote(user)},${quote(pass)} ${quote(this.url())}`,
      { redactInLog: `open -u ${quote(user)},***** ${quote(this.url())}` }
    );
    let err = detectLftpError(openOut);
    if (err) throw sessionError(err);

    // `open` succeeding means nothing — lftp connects lazily, and pwd can
    // return the raw connection URL (credentials included!) before a real
    // cd establishes a remote path. Validate with a real round-trip:
    // cd -> pwd -> cls, and check combined output for known failure text.
    const initialDir = site.remoteDir || '.';
    const cdOut = await this.exec(`cd ${quote(initialDir)}`, { timeout: 45_000 });
    err = detectLftpError(cdOut);
    if (err) throw sessionError(err);

    const pwdOut = await this.exec('pwd');
    err = detectLftpError(pwdOut);
    if (err) throw sessionError(err);
    const pwd = pwdOut.trim().split('\n').pop();
    // Defensive: even post-cd, never accept a URL-shaped pwd (could carry creds).
    this.cwd = /:\/\//.test(pwd) ? stripUrlToPath(pwd) : pwd;

    const clsOut = await this.exec(clsCommand('.'), { timeout: 45_000 });
    err = detectLftpError(clsOut);
    if (err) throw sessionError(err);

    this.connected = true;
    log('session', `[${this.id}] connected, cwd=${this.cwd}`);
    return { id: this.id, cwd: this.cwd };
  }

  // Queue a command; resolves with its full output (everything up to the sentinel).
  exec(command, opts = {}) {
    if (this.closed) return Promise.reject(new Error('session closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ command, opts, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    if (this.current || this.queue.length === 0 || !this.proc) return;
    const job = this.queue.shift();
    const sentinel = `__LFTP_DONE_${crypto.randomBytes(8).toString('hex')}__`;
    const timeoutMs = job.opts.timeout || DEFAULT_TIMEOUT_MS;
    this.current = {
      sentinel,
      resolve: job.resolve,
      reject: job.reject,
      timer: setTimeout(() => {
        log('session', `[${this.id}] command timed out after ${timeoutMs}ms`);
        this._failCurrent(new Error(`lftp command timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs),
    };
    log('session', `[${this.id}] > ${redact(job.opts.redactInLog || job.command)}`);
    this.proc.stdin.write(`${job.command}\n`);
    // `echo` is an lftp builtin; the sentinel line marks the boundary.
    this.proc.stdin.write(`echo ${sentinel}\n`);
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (!this.current) return;
    const idx = this.buffer.indexOf(this.current.sentinel);
    if (idx === -1) return;
    const output = this.buffer.slice(0, idx);
    // Drop the sentinel line (and its trailing newline) from the buffer.
    const after = this.buffer.indexOf('\n', idx);
    this.buffer = after === -1 ? '' : this.buffer.slice(after + 1);
    const { resolve, timer } = this.current;
    clearTimeout(timer);
    this.current = null;
    resolve(output);
    this._drain();
  }

  _failCurrent(err) {
    if (this.current) {
      clearTimeout(this.current.timer);
      const { reject } = this.current;
      this.current = null;
      reject(err);
    }
    while (this.queue.length) this.queue.shift().reject(err);
  }

  // ---- high-level operations -------------------------------------------

  async list(dir = '.') {
    const out = await this.exec(clsCommand(dir), { timeout: 60_000 });
    const err = detectLftpError(out);
    if (err) throw sessionError(err);
    return parseClsOutput(out);
  }

  async chdir(dir) {
    const out = await this.exec(`cd ${quote(dir)}`, { timeout: 45_000 });
    const err = detectLftpError(out);
    if (err) throw sessionError(err);
    const pwdOut = await this.exec('pwd');
    const pwdErr = detectLftpError(pwdOut);
    if (pwdErr) throw sessionError(pwdErr);
    const pwd = pwdOut.trim().split('\n').pop();
    this.cwd = /:\/\//.test(pwd) ? stripUrlToPath(pwd) : pwd;
    return this.cwd;
  }

  async mkdir(path) {
    const out = await this.exec(`mkdir -p ${quote(path)}`);
    const err = detectLftpError(out);
    if (err) throw sessionError(err);
  }

  async remove(path, isDir) {
    const cmd = isDir ? `rm -r ${quote(path)}` : `rm ${quote(path)}`;
    const out = await this.exec(cmd, { timeout: 120_000 });
    const err = detectLftpError(out);
    if (err) throw sessionError(err);
  }

  async rename(from, to) {
    const out = await this.exec(`mv ${quote(from)} ${quote(to)}`);
    const err = detectLftpError(out);
    if (err) throw sessionError(err);
  }

  close() {
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.stdin.write('exit\n');
      } catch (_) { /* already gone */ }
      const p = this.proc;
      setTimeout(() => {
        if (p.exitCode === null) p.kill('SIGKILL');
      }, 2000).unref();
    }
    log('session', `[${this.id}] closed`);
  }
}

// The date-format flag is --time-style (NOT --date-format — that fake flag
// makes cls error out and the error text silently looks like an empty
// listing). Fixed format so the parser regex below always matches.
function clsCommand(dir) {
  return `cls -la --time-style='+%Y-%m-%d %H:%M:%S' ${quote(dir)}`;
}

// Matches: -rw-r--r-- 1 user group 12345 2024-01-31 12:34:56 name
const CLS_LINE_RE =
  /^([\-dlbcps])([rwxstST\-]{9})\s+(?:\d+\s+)?(?:\S+\s+\S+\s+)?(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.+)$/;

function parseClsOutput(out) {
  const entries = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = CLS_LINE_RE.exec(line.trim());
    if (!m) continue; // skip totals/noise lines
    let name = m[5];
    let linkTarget = null;
    if (m[1] === 'l') {
      const arrow = name.indexOf(' -> ');
      if (arrow !== -1) {
        linkTarget = name.slice(arrow + 4);
        name = name.slice(0, arrow);
      }
    }
    if (name === '.' || name === '..') continue;
    entries.push({
      name,
      type: m[1] === 'd' ? 'dir' : m[1] === 'l' ? 'link' : 'file',
      permissions: m[1] + m[2],
      size: Number(m[3]),
      mtime: m[4],
      linkTarget,
    });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : b.type === 'dir' ? 1 : a.name.localeCompare(b.name)
  );
  return entries;
}

// Quote a value for the lftp command line.
function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// pwd can return the raw connection URL before a real cd; strip it down to
// a bare path so credentials never reach the client.
function stripUrlToPath(url) {
  try {
    const m = /^[a-z+]+:\/\/[^/]*(\/.*)?$/i.exec(url.trim());
    return (m && m[1]) || '/';
  } catch (_) {
    return '/';
  }
}

function sessionError(err) {
  const e = new Error(err.message);
  e.code = err.code;
  e.detail = err.detail;
  e.lftp = true;
  return e;
}

module.exports = { LftpSession, detectLftpError, ERROR_PATTERNS, parseClsOutput, quote, clsCommand };
