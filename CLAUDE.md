# CLAUDE.md — parallex-lftp

Context file for picking this project back up in a fresh chat. Covers what
it is, the decisions behind how it's built, what's actually working, and
what's still open.

## What this is

A FileZilla-style dual-pane file browser that runs as a web app in Docker,
using `lftp` as the actual transfer engine (not a hand-rolled FTP client).
Supports FTP, FTPS, and SFTP — lftp handles all three natively. Includes a
Site Manager (saved connection profiles) and a Settings panel for
transfer tuning (thread count, parallel segments per file, bandwidth cap).

This is the web-based pivot of an earlier idea (`Parallex FTP`, originally
sketched as a desktop Python client with segmented parallel transfers).
The segmented-transfer concept carried over, but the implementation now
leans on lftp's native `pget`/`pput -n <segments>` instead of a hand-rolled
transfer engine, and the delivery target became a self-contained Docker
web app instead of a desktop app.

## Architecture decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Backend language | Node.js / Express | User is comfortable with JS end-to-end; avoids introducing an unfamiliar backend language |
| "Local" pane | Browses a mounted Docker volume (`/data`) | The app runs headless in a container — it can't see the host desktop's real filesystem, only what's mounted in |
| lftp integration | **Persistent** lftp process per connection, not per-command | Enables real-time interaction, fewer reconnects, and gives direct access to lftp's native `pget`/`pput` for segmented transfers |
| Transfers | Separate **short-lived** lftp process per transfer job | Keeps long-running transfers from blocking the interactive browsing session; each job can be killed independently |
| Credential handling | Sent via `open -u user,pass` over **stdin**, never as CLI args | Keeps credentials out of `ps` output |
| SFTP host keys | Trust-on-first-use (`sftp:auto-confirm yes`), `HOME` pointed at the persistent `/config` volume | No TTY exists to answer an interactive host-key prompt; TOFU is the standard non-interactive equivalent, and pointing `HOME` at a mounted volume means an accepted key survives container rebuilds |
| Site storage | JSON file (`/config/sites.json`) | Simple, human-inspectable, good enough for a single-user tool |
| Settings storage | JSON file (`/config/settings.json`) | Same reasoning |
| Transfer progress | WebSocket broadcast from a `TransferManager` EventEmitter | Simple pub-sub; fine for a single-user tool with no auth boundaries to worry about between clients |
| File ownership | `entrypoint.sh` drops root to `PUID:PGID` (default 1000:1000) via `setpriv` before exec'ing node | Downloads into the mounted `./data` are editable on the host without sudo (LinuxServer.io convention). Entrypoint chowns `/config` (small) but **never recurses `/data`** (can be huge; new files are created as PUID:PGID anyway). `UMASK` env sets creation perms. `setpriv` comes with util-linux, already in debian-slim |

## lftp command wrapper details (the trickiest part)

lftp doesn't tag its output with command boundaries, so the wrapper
(`server/lftpSession.js`) sends every command followed by `echo <random
sentinel>` and buffers stdout until that sentinel line appears — everything
before it is that command's output. Commands are queued and run one at a
time so output never interleaves.

Key gotchas learned the hard way:
- `pwd` can return the **raw connection URL, credentials included**, before
  an actual `cd` establishes a real remote path. Never trust `pwd` output
  until after an explicit `cd`.
- `cls`'s date-format flag is `--time-style`, **not** `--date-format`. A
  bad flag makes `cls` print an error to stdout/stderr that doesn't look
  like a normal error — if you don't explicitly check for "unrecognized
  option", it silently looks like an empty directory.
- lftp "succeeding" (e.g. `pwd` resolving) doesn't mean the connection
  actually authenticated. Connection validation forces a real round-trip
  (`cd` → `pwd` → `cls`) and checks the combined output against a table of
  known lftp failure phrases (`detectLftpError` / `ERROR_PATTERNS` in
  `lftpSession.js`) before declaring the session ready.
- Any lftp output that might contain `user:pass@` gets run through a
  `redact()` helper (`server/logger.js`) before it's logged or returned to
  the client.
- `pwd` output (post-cd) is a **percent-encoded URL**: spaces come back as
  `%20`, and `.` segments / trailing slashes from cd arguments are kept
  verbatim. `stripUrlToPath` decodes and path-normalizes it — without that,
  paths built from cwd + entry name (e.g. transfer sources) are half
  encoded and lftp fails with "No such file".
- Real `cls` prints **directory names with a trailing slash**; the parser
  strips it or the slash gets baked into every built path.
- lftp only renders its **progress meter when stdout is a tty** — with
  piped stdio it prints nothing, so transfer progress stays blank forever.
  Transfer jobs run under a pty via `script -qefc` (bsdutils, present on
  debian-slim), with `stty -echo` so the pty doesn't echo the
  credential-carrying stdin back into the output stream.
- **lftp has no `pput`** (only `pget` exists). Segmented transfers are
  download-only; uploads always use plain `put`.
- **lftp's SFTP defaults are slow**: `sftp:size-read/write` (32K) and
  `sftp:max-packets-in-flight` (16) cap each connection at a few MB/s no
  matter the link. Both the session and transfer processes set 128K blocks
  and 64 packets in flight, which takes SFTP to line speed.
- Real per-segment progress comes from the **`<file>.lftp-pget-status`**
  file pget writes beside the download (`pget:save-status 2` makes it
  refresh every 2s): `size=` plus `N.pos=`/`N.limit=` per chunk, chunks
  contiguous, finished chunks dropping out of the file. The tty meter only
  gives an aggregate line, so without this the segment bar can only fake
  sequential fill.

## File structure

```
parallex-lftp/
  Dockerfile              node:20-slim + lftp + openssh-client
  docker-compose.yml      port 7609, mounts ./data -> /data, ./config -> /config
  server/
    index.js              Express app, static frontend, WebSocket broadcast, HOME/.ssh setup
    logger.js             log() + redact() helpers (credential scrubbing)
    lftpSession.js        Persistent lftp session wrapper (sentinel protocol, error detection)
    sessionManager.js     Tracks active LftpSession instances by session id
    transferManager.js    Per-job lftp processes for pget/pput, progress parsing, thread-limited queue
    jsonStore.js          Minimal JSON-file read/write helper
    routes/
      sites.js            Site Manager CRUD -> /config/sites.json
      settings.js         Transfer settings -> /config/settings.json
      local.js            Local fs browsing, sandboxed under LOCAL_ROOT
      remote.js           Remote browsing/ops via sessionManager
      transfers.js        Enqueue/list/cancel transfers
  public/
    index.html            App shell: toolbar, dual panes, transfer queue, Site Manager + Settings modals
    styles.css            Rack-equipment-inspired dark theme, IBM Plex Sans/Mono
    app.js                All frontend logic: API calls, rendering, WebSocket handling
  README.md               Setup/run instructions + known caveats
```

## What's implemented and working

- Dual-pane browsing (local via Node `fs`, remote via persistent lftp
  session) with clickable breadcrumb navigation
- Site Manager: create/edit/delete saved sites (name, host, port, protocol,
  username/password, remote/local initial directories, optional per-site
  threads/segments override). Passwords are never echoed back to the
  client (`hasPassword` flag instead; empty password on edit = keep stored)
- Global Settings: thread count, segments-per-file, minimum file size
  before segmenting kicks in, optional bandwidth cap
- Upload/download via toolbar buttons acting on the selected file —
  downloads use lftp's `pget -n <segments>` for real parallel segmented
  transfers; uploads use plain `put` (lftp has no `pput`)
- Live transfer queue over WebSocket: per-file segment fill visualization,
  percent, speed, ETA
- mkdir / delete / rename on both local and remote panes
- Request + connection lifecycle logging for debuggability
- Credential redaction in all logs and error responses

## Known gaps / not yet done

- **No auth on the web UI itself.** Anyone reaching port 7609 can use every
  saved site. Needs a reverse proxy with auth (or localhost/VPN-only
  deployment) before being exposed anywhere untrusted.
- **Site passwords stored in plaintext** in `config/sites.json`. Fine for a
  homelab behind your own firewall; not fine to share that folder or commit
  it to a repo (`config/` is gitignored for this reason).
- **SSH key auth has a spot in the schema/UI (`authType: 'key'`) but isn't
  wired up end-to-end** — only password auth is functional right now. The
  connect route rejects `authType: 'key'` sites with a clear error.
- **lftp's progress-meter text format can vary by version** — the regex in
  `transferManager.js` (`PROGRESS_RE`) was written against a typical
  `pget`/`pput` meter line; if live progress % stops updating after
  rebuilding on a different base image, check `docker logs` for the actual
  meter text and adjust that regex.
- **No drag-and-drop** — transfers are triggered via toolbar buttons acting
  on the current selection, not drag-between-panes.
- Trust-on-first-use for SSH host keys means a key seen for the very first
  time is accepted automatically. If that first key were somehow spoofed,
  it'd get trusted — a normal homelab-scale tradeoff, but worth knowing.
  (A key that later *changes* on an already-trusted host is still correctly
  rejected.)

## Running it

```bash
docker compose up --build
# open http://localhost:7609
```

`./data` on the host → `/data` in the container (what the LOCAL pane
browses). `./config` on the host → `/config` in the container (sites,
settings, and the SSH known_hosts store all persist there).

Local dev without Docker (needs `lftp` on the PATH):

```bash
npm install
LOCAL_ROOT=./data CONFIG_DIR=./config npm start
```
