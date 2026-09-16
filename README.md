# parallex-lftp
total AI slop, but it works and is free. 
A dual-pane file browser that runs as a web app in Docker,
using [`lftp`](https://lftp.yar.ru/) as the transfer engine. Supports
**FTP, FTPS, and SFTP**, with real parallel segmented transfers via lftp's
native `pget`/`pput -n <segments>`.

## Features

- **Dual-pane browsing** — local (a mounted Docker volume) on the left,
  remote server on the right, with clickable breadcrumb navigation
- **Site Manager** — saved connection profiles (host, protocol,
  credentials, initial directories, optional per-site thread/segment
  overrides), stored in `config/sites.json`
- **Transfer settings** — concurrent transfer count, segments per file,
  minimum file size before segmenting kicks in, optional bandwidth cap
- **Segmented parallel downloads** — large downloads use `pget -n
  <segments>` for multi-connection transfers (uploads use plain `put`;
  lftp has no segmented upload for a single file)
- **Live transfer queue** — per-file segment fill visualization, percent,
  speed, and ETA streamed over WebSocket
- **File operations** — mkdir / rename / delete on both local and remote
- **Credential hygiene** — site passwords are encrypted at rest
  (AES-256-GCM) in `config/sites.json`, passed to lftp over stdin (never
  CLI args, so they don't show in `ps`), and anything logged or returned
  to the browser is run through a redaction pass

## Running it

```bash
docker compose up --build
# open http://localhost:7609
```

Volumes:

| Host | Container | Purpose |
|---|---|---|
| `./data` | `/data` | What the LOCAL pane browses |
| `./config` | `/config` | `sites.json`, `settings.json`, SSH `known_hosts` |

## Configuration

Environment variables (already set by `docker-compose.yml` / `Dockerfile`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7609` | HTTP/WebSocket listen port |
| `LOCAL_ROOT` | `/data` | Sandbox root for the LOCAL pane |
| `CONFIG_DIR` | `/config` | Where sites/settings/known_hosts persist |

## File ownership (PUID/PGID)

The container drops from root to `PUID:PGID` (default `1000:1000`) before
starting the app, so downloaded files land in `./data` owned by that
uid/gid — editable on the host without sudo. Set them to your own user:

```bash
# find your ids
id -u   # -> PUID
id -g   # -> PGID

# either export them, or put them in a .env file next to docker-compose.yml:
#   PUID=1000
#   PGID=1000
PUID=$(id -u) PGID=$(id -g) docker compose up --build
```

`UMASK` (default `022`) controls the permission bits on newly created
files; use `002` if a shared group should also get write access. The
entrypoint also chowns `./config` (sites, settings, known_hosts) to
`PUID:PGID`, but never touches ownership inside `./data`.

## SSH host keys (SFTP)

There's no TTY in the container to answer lftp's interactive host-key
prompt, so SFTP uses **trust-on-first-use** (`sftp:auto-confirm yes`).
`HOME` points at the `/config` volume, so an accepted key lands in
`config/.ssh/known_hosts` and survives container rebuilds. A key that
*changes* on an already-trusted host is still rejected.

## Known caveats

- **No auth on the web UI itself.** Anyone who can reach port 7609 can use
  every saved site. Put it behind a reverse proxy with auth, or keep it
  localhost/VPN-only.
- **Credential encryption is at-rest, not end-to-end.** Site passwords in
  `config/sites.json` are AES-256-GCM encrypted. The key comes from the
  `PARALLEX_SECRET` env var when set (recommended — put it in a `.env`
  file; the key then never touches the `config/` volume), otherwise from
  an auto-generated `config/.secret` keyfile (mode 600). Existing
  plaintext files are migrated automatically on boot, and setting
  `PARALLEX_SECRET` later transparently re-encrypts. Someone with both
  the config folder **and** the secret can still decrypt — this protects
  a leaked/backed-up/committed `sites.json`, not a fully compromised
  host. (`config/` and `data/` are gitignored regardless.)
- **SSH key auth isn't wired up yet** — the schema/UI has a spot for it
  (`authType: 'key'`), but only password auth works end-to-end.
- **lftp's progress-meter text can vary by version.** If live progress
  stops updating after changing the base image, check `docker logs` for
  the actual meter line and adjust `PROGRESS_RE` in
  `server/transferManager.js`.
- **No drag-and-drop** — transfers go through the toolbar Upload/Download
  buttons acting on the current selection.
- Trust-on-first-use means the very first key seen for a host is accepted
  automatically — a normal homelab-scale tradeoff.

## Development

```bash
npm install
LOCAL_ROOT=./data CONFIG_DIR=./config PORT=7609 npm start
```

Requires `lftp` on the PATH (and `openssh-client` for SFTP).
