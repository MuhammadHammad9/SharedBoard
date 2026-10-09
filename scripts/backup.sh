#!/usr/bin/env bash
# CoBoard database backup — PRD §7.3 ("automated daily backups").
#
#   scripts/backup.sh                 # or: pnpm db:backup
#
# Writes a pg_dump CUSTOM-format archive (compressed, restorable table by table
# with pg_restore) named coboard-<UTC timestamp>.dump, verifies it can be read
# back, writes a .sha256 beside it, optionally copies both to S3, and prunes
# local archives older than the retention window. Prints the archive path on
# stdout (everything else goes to stderr), so callers can capture it.
#
# Environment:
#   DATABASE_URL            source database (default: from .env)
#   BACKUP_DIR              where archives go            (default: <repo>/backups)
#   BACKUP_RETENTION_DAYS   local pruning window         (default: 14)
#   BACKUP_S3_BUCKET        if set: aws s3 cp the archive to s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX
#   BACKUP_S3_PREFIX        key prefix                   (default: coboard/postgres/)
#   PG_DUMP_SNAPSHOT        dump inside an exported snapshot (used by test-restore.sh)
#
# S3 retention is a bucket lifecycle rule, not this script: a host that can
# delete old backups is a host whose compromise can delete all of them.
# docs/RUNBOOK.md §4 has the rule.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/pg-common.sh"

require pg_dump pg_restore
load_database_url

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be a whole number of days"
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
db="$(url_db_name "$DATABASE_URL")"
file="$BACKUP_DIR/${db}-${stamp}.dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

snapshot_args=()
[[ -n "${PG_DUMP_SNAPSHOT:-}" ]] && snapshot_args=(--snapshot="$PG_DUMP_SNAPSHOT")

log "dumping $(url_identity "$DATABASE_URL") -> $file"
# --no-owner/--no-acl: restorable into a database with different role names
# (a scratch DB, a fresh managed instance). Written to .partial and renamed,
# so a crash mid-dump never leaves a truncated file that looks like a backup.
pg_dump --dbname="$(libpq_url "$DATABASE_URL")" \
  --format=custom --compress=6 --no-owner --no-acl \
  ${snapshot_args[@]+"${snapshot_args[@]}"} --file="$partial"

# A dump that pg_restore cannot list is not a backup.
pg_restore --list "$partial" >/dev/null || die "archive failed verification: $partial"
mv "$partial" "$file"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$file")" >"$(basename "$file").sha256")
log "ok: $(du -h "$file" | cut -f1)"

if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  require aws
  dest="s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-coboard/postgres/}"
  log "uploading to $dest"
  aws s3 cp --only-show-errors "$file" "$dest"
  aws s3 cp --only-show-errors "$file.sha256" "$dest"
fi

# Retention: local archives only, and never the one just written.
if ((RETENTION_DAYS > 0)); then
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.dump.sha256' \) \
    -mtime +"$RETENTION_DAYS" ! -name "$(basename "$file")*" -print -delete |
    sed 's/^/[prune] /' >&2
fi

printf '%s\n' "$file"
