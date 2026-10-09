#!/usr/bin/env bash
# The TESTED restore — PRD §7.3 ("automated daily backups with a tested restore").
#
#   scripts/test-restore.sh            # or: pnpm db:test-restore
#
# Proves, end to end, that scripts/backup.sh produces an archive that
# scripts/restore.sh turns back into the same data:
#
#   1. if the source op log is empty, seed one known board (SQL, idempotent)
#   2. open a REPEATABLE READ transaction on the source and export its snapshot
#   3. fingerprint the source INSIDE that snapshot: row count of every table,
#      max(seq) of the op log per board, Board.currentSeq, and an md5 over the
#      whole op log in (board, seq) order
#   4. back up with scripts/backup.sh, dumping that SAME snapshot
#   5. create a scratch database and restore into it with scripts/restore.sh
#   6. fingerprint the scratch database and diff the two
#   7. drop the scratch database (always, via trap)
#
# Exits non-zero on any mismatch. Steps 2–4 share one snapshot, so the check is
# exact even while the source is being written to (a live server, a test run).
#
# Environment: DATABASE_URL (source; default from .env). The role needs
# CREATEDB. KEEP_ARCHIVE=1 leaves the archive in BACKUP_DIR instead of a temp dir.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/pg-common.sh"

require psql pg_dump pg_restore
load_database_url

SRC="$(libpq_url "$DATABASE_URL")"
MAINT="$(url_with_db "$DATABASE_URL" postgres)"
SCRATCH_DB="coboard_restore_test_$(date -u +%Y%m%d%H%M%S)_$$"
SCRATCH="$(url_with_db "$DATABASE_URL" "$SCRATCH_DB")"

work="$(mktemp -d)"
holder_pid=""
scratch_created=0

cleanup() {
  local code=$?
  if [[ -n "$holder_pid" ]]; then
    { exec 7>&-; } 2>/dev/null || true
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  if ((scratch_created)); then
    psql -X -q "$MAINT" -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null 2>&1 &&
      log "dropped scratch database $SCRATCH_DB" ||
      log "WARNING: could not drop scratch database $SCRATCH_DB — drop it by hand"
  fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT INT TERM

q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }

# ── 1. Known board, only if there is nothing to back up ──────────────────────
if [[ "$(q "$SRC" -c 'SELECT count(*) FROM "Operation"')" == 0 ]]; then
  log "source op log is empty; seeding the restore-drill board"
  q "$SRC" <<'SQL'
BEGIN;
INSERT INTO "User" (id, email, "emailLower", "displayName", "updatedAt")
VALUES ('00000000-0000-4000-8000-00000000d001', 'restore-drill@coboard.dev',
        'restore-drill@coboard.dev', 'Restore Drill', now())
ON CONFLICT DO NOTHING;
INSERT INTO "Board" (id, name, "ownerId", "currentSeq", "objectCount", "updatedAt")
VALUES ('00000000-0000-4000-8000-00000000db01', 'Restore drill: known board',
        '00000000-0000-4000-8000-00000000d001', 25, 25, now())
ON CONFLICT DO NOTHING;
INSERT INTO "BoardMember" (id, "boardId", "userId", role)
VALUES ('00000000-0000-4000-8000-00000000dm01', '00000000-0000-4000-8000-00000000db01',
        '00000000-0000-4000-8000-00000000d001', 'OWNER')
ON CONFLICT DO NOTHING;
INSERT INTO "Operation" (id, "boardId", seq, type, "objectId", payload, "actorId")
SELECT format('00000000-0000-4000-8000-0000000c%s', lpad(s::text, 4, '0')),
       '00000000-0000-4000-8000-00000000db01', s, 'CREATE',
       format('00000000-0000-4000-8000-0000000b%s', lpad(s::text, 4, '0')),
       jsonb_build_object('type', 'rect', 'x', s * 40, 'y', 0, 'w', 32, 'h', 32,
                          'style', jsonb_build_object('fill', '#4F46E5')),
       '00000000-0000-4000-8000-00000000d001'
FROM generate_series(1, 25) AS s
ON CONFLICT DO NOTHING;
INSERT INTO "Snapshot" (id, "boardId", seq, state)
VALUES ('00000000-0000-4000-8000-00000000d501', '00000000-0000-4000-8000-00000000db01',
        25, '{"objects":[]}')
ON CONFLICT DO NOTHING;
COMMIT;
SQL
fi

# ── 2. Hold one snapshot open for the fingerprint and the dump ───────────────
mkfifo "$work/holder.in"
q "$SRC" <"$work/holder.in" >"$work/holder.out" 2>&1 &
holder_pid=$!
exec 7>"$work/holder.in"
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&7
snapshot=""
for _ in $(seq 1 100); do
  snapshot="$(grep -Eo '^[0-9A-F]+-[0-9A-F]+(-[0-9]+)?$' "$work/holder.out" | head -n 1 || true)"
  [[ -n "$snapshot" ]] && break
  kill -0 "$holder_pid" 2>/dev/null || die "snapshot session exited: $(cat "$work/holder.out")"
  sleep 0.1
done
[[ -n "$snapshot" ]] || die "timed out waiting for an exported snapshot"
log "holding snapshot $snapshot"

# ── 3. Fingerprint ───────────────────────────────────────────────────────────
mapfile -t tables < <(q "$SRC" -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
((${#tables[@]})) || die "source has no tables in schema public — run migrations first"

fingerprint_sql="$(
  for t in "${tables[@]}"; do
    printf "SELECT 'rows' AS k, '%s' AS name, count(*)::text AS v FROM public.\"%s\" UNION ALL\n" "$t" "$t"
  done
  cat <<'SQL'
SELECT 'op_max_seq', "boardId", max(seq)::text FROM "Operation" GROUP BY "boardId" UNION ALL
SELECT 'board_current_seq', id, "currentSeq"::text FROM "Board" UNION ALL
SELECT 'op_log_md5', '*', md5(coalesce(string_agg(
         id || ':' || seq || ':' || type || ':' || "objectId" || ':' || payload::text,
         ',' ORDER BY "boardId", seq), ''))
  FROM "Operation"
ORDER BY 1, 2;
SQL
)"

fingerprint() { # <url> [snapshot]
  {
    if [[ -n "${2:-}" ]]; then
      echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
      echo "SET TRANSACTION SNAPSHOT '$2';"
    fi
    echo "$fingerprint_sql"
    if [[ -n "${2:-}" ]]; then echo "COMMIT;"; fi
  } | q -F ' ' "$1"
}

fingerprint "$SRC" "$snapshot" >"$work/source.txt"
ops="$(awk '$1 == "rows" && $2 == "Operation" { print $3 }' "$work/source.txt")"
[[ "${ops:-0}" -gt 0 ]] || die "snapshot holds no operations — nothing meaningful to verify"
log "source: ${#tables[@]} tables, $ops operations, $(grep -c '^op_max_seq' "$work/source.txt") boards with ops"

# ── 4. Back up that same snapshot ────────────────────────────────────────────
backup_dir="$work/backups"
((${KEEP_ARCHIVE:-0})) && backup_dir="${BACKUP_DIR:-$REPO_ROOT/backups}"
archive="$(BACKUP_DIR="$backup_dir" BACKUP_S3_BUCKET="" BACKUP_RETENTION_DAYS=0 \
  PG_DUMP_SNAPSHOT="$snapshot" bash "$REPO_ROOT/scripts/backup.sh")"

echo "COMMIT;" >&7
exec 7>&-
wait "$holder_pid" || true
holder_pid=""

# ── 5. Restore into a scratch database ───────────────────────────────────────
q "$MAINT" -c "CREATE DATABASE \"$SCRATCH_DB\""
scratch_created=1
log "created scratch database $SCRATCH_DB"
PRODUCTION_DATABASE_URL="" bash "$REPO_ROOT/scripts/restore.sh" "$archive" --target "$SCRATCH"

# ── 6. Compare ───────────────────────────────────────────────────────────────
fingerprint "$SCRATCH" >"$work/restored.txt"

if ! diff -u "$work/source.txt" "$work/restored.txt" >"$work/diff.txt"; then
  log "MISMATCH between source snapshot and restored database:"
  head -n 60 "$work/diff.txt" >&2
  exit 1
fi

{
  printf '\n%-24s %12s %12s\n' "table" "source" "restored"
  join <(awk '$1 == "rows" { print $2, $3 }' "$work/source.txt") \
    <(awk '$1 == "rows" { print $2, $3 }' "$work/restored.txt") |
    awk '{ printf "%-24s %12s %12s\n", $1, $2, $3 }'
  printf '%-24s %12s\n' "boards: max(seq) match" "$(grep -c '^op_max_seq' "$work/restored.txt")"
  printf '%-24s %s\n\n' "op log md5" "$(awk '$1 == "op_log_md5" { print $3 }' "$work/restored.txt")"
} >&2
log "PASS: restore of $(basename "$archive") matches the source snapshot"
