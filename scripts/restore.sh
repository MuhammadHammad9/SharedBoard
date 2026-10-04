#!/usr/bin/env bash
# CoBoard database restore.
#
#   scripts/restore.sh <archive> --target <DATABASE_URL> [--force]
#   pnpm db:restore -- <archive> --target <DATABASE_URL>
#
# <archive> is a scripts/backup.sh file, or an s3:// URL (downloaded with the
# aws CLI first). The target database must already exist; its existing objects
# are dropped and replaced (pg_restore --clean --if-exists) inside ONE
# transaction, so a failed restore leaves the target as it was.
#
# Refuses, unless --force, when the target looks like production:
#   - it is the same host:port/db as $PRODUCTION_DATABASE_URL, or
#   - it is the same as $DATABASE_URL while NODE_ENV=production.
# The normal recovery path restores into a NEW database and repoints the app
# at it (docs/RUNBOOK.md §5); overwriting the live database is the exception.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/pg-common.sh"

usage() { sed -n '4,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

archive="" target="" force=0
while (($#)); do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --target=*) target="${1#*=}"; shift ;;
    --force) force=1; shift ;;
    -h | --help) usage ;;
    --) shift ;;
    -*) die "unknown option $1" ;;
    *) [[ -z "$archive" ]] || usage; archive="$1"; shift ;;
  esac
done
[[ -n "$archive" && -n "$target" ]] || usage
require pg_restore psql

target_id="$(url_identity "$target")"
protected=()
[[ -n "${PRODUCTION_DATABASE_URL:-}" ]] && protected+=("$(url_identity "$PRODUCTION_DATABASE_URL")")
[[ "${NODE_ENV:-}" == production && -n "${DATABASE_URL:-}" ]] && protected+=("$(url_identity "$DATABASE_URL")")
for p in ${protected[@]+"${protected[@]}"}; do
  if [[ "$p" == "$target_id" ]]; then
    ((force)) || die "refusing to restore over production database $target_id (pass --force if you really mean it)"
    log "WARNING: --force given; overwriting production database $target_id"
  fi
done

if [[ "$archive" == s3://* ]]; then
  require aws
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  log "downloading $archive"
  aws s3 cp --only-show-errors "$archive" "$tmp/restore.dump"
  if aws s3 cp --only-show-errors "$archive.sha256" "$tmp/restore.dump.sha256" 2>/dev/null; then
    (cd "$tmp" && sed 's/ .*$/  restore.dump/' restore.dump.sha256 | sha256sum -c --quiet -) ||
      die "checksum mismatch: $archive"
  else
    log "no checksum alongside $archive; skipping integrity check"
  fi
  archive="$tmp/restore.dump"
else
  [[ -f "$archive" ]] || die "no such archive: $archive"
  if [[ -f "$archive.sha256" ]]; then
    (cd "$(dirname "$archive")" && sha256sum -c --quiet "$(basename "$archive").sha256") ||
      die "checksum mismatch: $archive"
  fi
fi

log "restoring $(basename "$archive") -> $target_id"
pg_restore --dbname="$(libpq_url "$target")" \
  --clean --if-exists --no-owner --no-acl \
  --single-transaction --exit-on-error \
  "$archive"
log "restore complete: $target_id"
