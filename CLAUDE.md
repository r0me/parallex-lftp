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
| Credential storage | AES-256-GCM at rest (`server/secretStore.js`), stored as `enc:v1:<b64(iv\|tag\|ct)>` | Key from `PARALLEX_SECRET` env (scrypt-derived; keeps the key out of the volume) or an auto-generated `/config/.secret` keyfile (0600). Boot migration encrypts legacy plaintext and re-encrypts keyfile-era values once a secret is set (decrypt tries primary key, then keyfile fallback). Decrypted only in memory at connect/enqueue; never in API responses or logs. At-rest protection only — config volume + secret together still decrypt |
| Settings storage | JSON file (`/config/settings.json`) | Same reasoning |
| Transfer progress | WebSocket broadcast from a `TransferManager` EventEmitter | Simple pub-sub; fine for a single-user tool with no auth boundaries to worry about between clients |
| Web-UI auth | Single local account (`server/auth.js`): scrypt hash in `/config/auth.json`, stateless signed session cookie (7d, httpOnly, SameSite=Lax), HMAC key HKDF-derived from the secretStore primary key | First-run setup screen, or `AUTH_USERNAME`/`AUTH_PASSWORD` env seed (hashed at boot, never stored). All `/api/*` except `/api/auth/*` gated by `requireAuth`; WS upgrade verified too (close 4401). Password change bumps `tokenVersion` → old cookies die. Lockout recovery = delete auth.json + restart. Login failures rate-damped. HTTP-only, so TLS proxy still advised beyond the LAN |
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
  download-only; single-file uploads always use plain `put`.
- **Folders** transfer with `mirror` (recursive), `mirror -R` for upload,
  `--parallel=<threads>` across files plus `--use-pget-n=<segments>` per
  file on download. mirror emits per-file meters, not one aggregate, so
  folder-download progress is measured differently: a poll of the local
  destination tree (fs) for bytes/speed, and an async `du -bs` on the
  remote for the total → percent (best-effort; percent stays indeterminate
  if `du` fails). This is version-independent since it never parses
  mirror's own output for progress. mirror runs with `--verbose`; the
  `Transferring file`/`Making directory` action lines drive the current-file
  + file-count shown in the queue and are echoed to the server log. Crucial:
  folder jobs **must ignore** mirror's per-file `got N of M (P%)` meter
  lines for percent (they'd spike the whole-folder percent to one file's
  progress) — only `!isDir` jobs let `PROGRESS_RE` drive percent.
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
  .github/workflows/docker.yml  pushes ghcr.io/r0me/parallex-lftp:latest (amd64+arm64) on main
  unraid-template.xml     Unraid Docker template (GHCR image, PUID 99/PGID 100 defaults)
  docs/icon.png           64x64 stripe-mark icon referenced by the Unraid template
  server/
    index.js              Express app, static frontend, WebSocket broadcast, HOME/.ssh setup, credential migration
    logger.js             log() + redact() helpers (credential scrubbing)
    secretStore.js        AES-256-GCM credential encryption at rest (env secret or keyfile) + session signing key
    auth.js               Single-user auth: scrypt user store, signed-cookie sessions, requireAuth, /api/auth routes
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

- Single-user login gating the whole API and WebSocket (first-run setup
  screen or env seed; logout button; see the auth decision row)
- Dual-pane browsing (local via Node `fs`, remote via persistent lftp
  session) with clickable breadcrumb navigation
- Site Manager: create/edit/delete saved sites (name, host, port, protocol,
  username/password, remote/local initial directories, optional per-site
  threads/segments override). Passwords are never echoed back to the
  client (`hasPassword` flag instead; empty password on edit = keep stored)
- Global Settings: thread count, segments-per-file, minimum file size
  before segmenting kicks in, optional bandwidth cap
- Themes: Rack Amber (default), Retro Green (black/green phosphor), Deep
  Blue — picker in Settings; choice persists in `settings.json` and is
  mirrored to `localStorage` so the page paints right pre-auth. Themes are
  token overrides on `:root[data-theme=...]` in `styles.css`. The brand
  (header wordmark + `favicon.svg`) is fixed blue/green in every theme
- Upload/download via toolbar buttons acting on the selected entry —
  single-file downloads use `pget -n <segments>` (parallel segmented),
  single-file uploads use plain `put`; **folders** transfer recursively
  via `mirror` (`mirror -R` for upload) with `--parallel` across files and
  `--use-pget-n` on the way down. Folder-download progress is measured by
  polling the local destination size against the remote total from a `du`
- Live transfer queue over WebSocket: per-file segment fill visualization,
  percent, speed, ETA
- mkdir / delete / rename on both local and remote panes
- Request + connection lifecycle logging for debuggability
- Credential redaction in all logs and error responses
- CI image publishing: GitHub Actions pushes
  `ghcr.io/r0me/parallex-lftp:latest` + `:sha` (amd64/arm64) on every
  main push; `unraid-template.xml` deploys that image on Unraid (GHCR
  package must be set public once for anonymous pulls)

## Known gaps / not yet done

- **Auth is single-user, homelab-grade, and HTTP-only.** The login gate
  works, but without TLS the password/cookie are cleartext on the wire —
  a TLS reverse proxy is still the answer for anything beyond the LAN.
  No multi-user, no 2FA, sessions can't be revoked individually (only
  all at once via password change).
- **Credential encryption is at-rest only** (see the decision table): a
  leaked `sites.json` alone is useless, but config volume + secret
  together still decrypt. `PARALLEX_SECRET` in a `.env` file is the
  recommended setup. If the secret is lost/changed with no keyfile
  fallback, connect returns a clear 409 telling the user to re-enter that
  site's password. `config/` stays gitignored regardless.
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
