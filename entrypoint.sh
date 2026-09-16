#!/bin/sh
# Run the app as PUID:PGID (LinuxServer.io-style) so files written to the
# mounted volumes are editable on the host without sudo.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
umask "${UMASK:-022}"

# Already non-root (e.g. `user:` in compose)? Nothing to drop.
if [ "$(id -u)" != "0" ]; then
  exec node server/index.js
fi

mkdir -p /config/.ssh /data

# chown /config (small: json files + known_hosts). /data gets only its
# top-level dir chowned (covers docker having created the bind-mount dir
# as root) — never recursed: it can be huge, new files are created as
# PUID:PGID anyway, and existing host files already belong to the user.
chown -R "$PUID:$PGID" /config
chown "$PUID:$PGID" /data
chmod 700 /config/.ssh

echo "entrypoint: dropping to uid=$PUID gid=$PGID (umask $(umask))"
exec setpriv --reuid "$PUID" --regid "$PGID" --clear-groups node server/index.js
