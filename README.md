# parallex-lftp

A FileZilla-style dual-pane file browser that runs as a web app in Docker,
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
- **Segmented parallel transfers** — downloads/uploads use `pget`/`pput
  -n <segments>` for multi-connection transfers of large files
- **Live transfer queue** — per-file segment fill visualization, percent,
  speed, and ETA streamed over WebSocket
- **File operations** — mkdir / rename / delete on both local and remote
- **Credential hygiene** — passwords are passed to lftp over stdin (never
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
- **Site passwords are stored in plaintext** in `config/sites.json`. Fine
  for a homelab behind your own firewall; don't share that folder or commit
  it anywhere. (`config/` and `data/` are gitignored.)
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
