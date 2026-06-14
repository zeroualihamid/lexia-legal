#!/bin/sh
# Wait for Postgres, then run better-auth migrations.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[auth-migrate] DATABASE_URL not set" >&2
  exit 1
fi

# Parse host:port out of postgres://user:pass@host:port/db
HOSTPORT=$(echo "${DATABASE_URL}" | sed -E 's#^[a-z]+://[^@]+@([^/]+)/.*#\1#')
HOST=$(echo "${HOSTPORT}" | cut -d: -f1)
PORT=$(echo "${HOSTPORT}" | cut -d: -f2)
PORT=${PORT:-5432}

echo "[auth-migrate] waiting for postgres at ${HOST}:${PORT} ..."
i=0
until pg_isready -h "${HOST}" -p "${PORT}" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "[auth-migrate] postgres did not become ready in time" >&2
    exit 1
  fi
  sleep 1
done

cd /app
echo "[auth-migrate] running better-auth migrations"
# `auth` (formerly @better-auth/cli — now deprecated) is the official CLI,
# bundled in node_modules so this runs offline. It loads src/auth.ts via jiti.
node_modules/.bin/auth migrate --yes

echo "[auth-migrate] done"
