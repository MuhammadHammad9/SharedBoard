#!/usr/bin/env bash
#
# Native Postgres + Redis fallback for environments without a Docker daemon.
#
# The canonical path is `docker compose up -d` (see docker-compose.yml). Use
# this only where Docker is unavailable — some CI sandboxes and remote dev
# containers. It produces the same DATABASE_URL and REDIS_URL, so .env does not
# change between the two paths.
#
# Requires root (or passwordless sudo) to start the Postgres cluster.
#
# Usage:  bash scripts/dev-services.sh [--stop]

set -euo pipefail

DB_NAME="${DB_NAME:-coboard}"
DB_USER="${DB_USER:-coboard}"
DB_PASS="${DB_PASS:-coboard}"
DB_PORT="${DB_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"

log() { printf '[services] %s\n' "$1"; }
die() { printf '[services] ERROR: %s\n' "$1" >&2; exit 1; }

as_postgres() {
  if [ "$(id -u)" -eq 0 ]; then su postgres -c "$1"; else sudo -u postgres bash -c "$1"; fi
}

stop_services() {
  log 'stopping redis'
  redis-cli -p "$REDIS_PORT" shutdown nosave 2>/dev/null || true
  log 'stopping postgres'
  pg_ctlcluster "$PG_VERSION" main stop 2>/dev/null || true
  log 'stopped'
}

# Detect the installed Postgres major version.
PG_VERSION="$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1 || true)"
[ -n "$PG_VERSION" ] || die 'no PostgreSQL server found. Install postgresql, or use docker compose.'

if [ "${1:-}" = '--stop' ]; then
  stop_services
  exit 0
fi

# ── PostgreSQL ───────────────────────────────────────────────────────────────
log "using PostgreSQL $PG_VERSION"

if pg_isready -q -p "$DB_PORT" 2>/dev/null; then
  log "postgres already running on :$DB_PORT"
else
  log 'starting postgres cluster'
  pg_ctlcluster "$PG_VERSION" main start
  for _ in $(seq 1 30); do
    pg_isready -q -p "$DB_PORT" 2>/dev/null && break
    sleep 0.5
  done
  pg_isready -q -p "$DB_PORT" || die 'postgres failed to start'
  log "postgres up on :$DB_PORT"
fi

# Role and database are created idempotently.
if as_postgres "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" | grep -q 1; then
  log "role '$DB_USER' exists"
else
  log "creating role '$DB_USER'"
  as_postgres "psql -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS' CREATEDB\""
fi

if as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1; then
  log "database '$DB_NAME' exists"
else
  log "creating database '$DB_NAME'"
  as_postgres "createdb -O $DB_USER $DB_NAME"
fi

# ── Redis ────────────────────────────────────────────────────────────────────
if redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  log "redis already running on :$REDIS_PORT"
else
  command -v redis-server >/dev/null || die 'no redis-server found. Install redis, or use docker compose.'
  log 'starting redis'
  redis-server --port "$REDIS_PORT" --daemonize yes --save '' --appendonly no
  for _ in $(seq 1 20); do
    redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break
    sleep 0.25
  done
  redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 || die 'redis failed to start'
  log "redis up on :$REDIS_PORT"
fi

cat <<EOF

[services] ready.

  DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:$DB_PORT/$DB_NAME
  REDIS_URL=redis://localhost:$REDIS_PORT

Next:  pnpm db:migrate
Stop:  bash scripts/dev-services.sh --stop
EOF
