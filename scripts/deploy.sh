#!/usr/bin/env bash
# CoBoard deploy, run ON the production host from the deploy directory
# (the one holding infra/ and scripts/). .github/workflows/deploy.yml calls it
# over SSH; a human can run it the same way (docs/RUNBOOK.md §2).
#
#   TAG=<git sha> scripts/deploy.sh pull       # fetch images for TAG
#   TAG=<git sha> scripts/deploy.sh migrate    # release command: prisma migrate deploy
#   TAG=<git sha> scripts/deploy.sh rollout    # rolling restart onto TAG
#   TAG=<git sha> scripts/deploy.sh all        # pull + migrate + rollout
#
# Rollback = `TAG=<previous sha> scripts/deploy.sh rollout` (see
# .deploy-history). It deliberately skips `migrate`: migrations only move
# forward, and every migration must keep the previous release working
# (expand/contract, docs/RUNBOOK.md §3).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${TAG:?set TAG to the image tag (git sha) to deploy}"
export TAG GHCR_OWNER="${GHCR_OWNER:-muhammadhammad9}"

compose() { docker compose -f infra/docker-compose.prod.yml "$@"; }
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

[[ -f infra/env/server.env ]] || { log "infra/env/server.env is missing (copy server.env.example and fill it in)"; exit 1; }

# Every server-N service in the compose file, so scaling needs no edit here.
servers() { compose config --services | grep -E '^server-[0-9]+$' | sort -V; }

wait_healthy() {
  local svc="$1" cid status
  cid="$(compose ps -q "$svc")"
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
    case "$status" in
      healthy) log "$svc healthy"; return 0 ;;
      unhealthy | exited | dead) break ;;
    esac
    sleep 2
  done
  log "$svc did not become healthy (last status: ${status:-unknown}). Last log lines:"
  compose logs --tail 40 "$svc" >&2 || true
  log "ROLL BACK: TAG=$(tail -n 1 .deploy-history 2>/dev/null | cut -d' ' -f2) scripts/deploy.sh rollout"
  return 1
}

pull() {
  log "pulling images for $TAG"
  compose --profile release pull web migrate $(servers)
}

migrate() {
  log "running migrations (prisma migrate deploy) with coboard-migrate:$TAG"
  compose up -d --no-recreate postgres redis
  compose --profile release run --rm migrate
}

rollout() {
  compose up -d --no-recreate postgres redis
  # One instance at a time: while server-1 restarts, nginx marks it failed and
  # its clients reconnect to the others (TRD §15.2 — any instance can serve
  # any board, Redis pub/sub bridges them). Unacked ops replay from each
  # client's outbox, so a restart costs a reconnect, never an op.
  local svc
  for svc in $(servers); do
    log "rolling $svc -> $TAG"
    compose up -d --no-deps "$svc"
    wait_healthy "$svc"
    # nginx resolves upstream hostnames when it loads its config, and a
    # recreated container usually gets a new IP. Reload now, before the next
    # instance goes down, or nginx keeps sending to the dead address and both
    # upstreams end up stale (Phase 15 audit).
    compose exec -T lb nginx -s reload || true
  done
  log "rolling web -> $TAG"
  compose up -d --no-deps web
  wait_healthy web
  compose up -d --no-deps lb
  # Picks up lb.conf changes (e.g. a new upstream line) without dropping
  # sockets. This works because the deploy extracts with `tar --overwrite`,
  # which rewrites the bind-mounted file in place (same inode); a plain
  # extract replaces the inode and the container would keep the old file.
  compose exec -T lb nginx -s reload
  wait_healthy lb
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" >>.deploy-history
  log "deployed $TAG"
}

case "${1:-all}" in
  pull) pull ;;
  migrate) migrate ;;
  rollout) rollout ;;
  all) pull && migrate && rollout ;;
  *) echo "usage: TAG=<sha> $0 {pull|migrate|rollout|all}" >&2; exit 2 ;;
esac
