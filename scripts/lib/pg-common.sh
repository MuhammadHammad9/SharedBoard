# shellcheck shell=bash
# Shared helpers for scripts/backup.sh, restore.sh and test-restore.sh.
# Sourced, never executed.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is not installed (needs the PostgreSQL client tools)"
  done
}

# DATABASE_URL from the environment, else from the repo's .env — the same
# precedence the server uses (a real environment variable always wins).
load_database_url() {
  if [[ -z "${DATABASE_URL:-}" && -f "$REPO_ROOT/.env" ]]; then
    DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$REPO_ROOT/.env" | tail -n 1)"
    DATABASE_URL="${DATABASE_URL%\"}"; DATABASE_URL="${DATABASE_URL#\"}"
  fi
  [[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set (environment or .env)"
  export DATABASE_URL
}

# Prisma URLs carry query parameters libpq rejects (`schema`, `connection_limit`,
# `pool_timeout`, `pgbouncer`, …). Keep only the ones libpq understands.
libpq_url() {
  local url="$1" base query out="" param
  local -a params
  base="${url%%\?*}"
  [[ "$url" == *\?* ]] || { printf '%s' "$base"; return; }
  query="${url#*\?}"
  IFS='&' read -r -a params <<<"$query"
  for param in "${params[@]}"; do
    case "${param%%=*}" in
      sslmode | sslcert | sslkey | sslrootcert | connect_timeout | application_name | options | target_session_attrs)
        out+="${out:+&}$param" ;;
    esac
  done
  printf '%s%s' "$base" "${out:+?$out}"
}

# Replace the database name in a URL: url_with_db <url> <dbname>
url_with_db() {
  local url base query=""
  url="$(libpq_url "$1")"
  base="${url%%\?*}"
  [[ "$url" == *\?* ]] && query="?${url#*\?}"
  printf '%s/%s%s' "${base%/*}" "$2" "$query"
}

url_db_name() {
  local base="${1%%\?*}"
  printf '%s' "${base##*/}"
}

# host:port/db with credentials stripped — safe to log, and the identity
# compared when refusing to restore over production.
url_identity() {
  local base="${1%%\?*}" rest hostport
  rest="${base#*://}"
  rest="${rest#*@}"
  hostport="${rest%%/*}"
  [[ "$hostport" == *:* ]] || hostport="$hostport:5432"
  printf '%s/%s' "$hostport" "${rest#*/}"
}
