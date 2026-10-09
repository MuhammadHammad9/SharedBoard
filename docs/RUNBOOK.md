# CoBoard runbook

How to deploy, recover and operate CoBoard in production. Phase 15f; the design is TRD §15.1–§15.4 and PRD §7.3 (99.5% uptime, zero committed-op loss, automated daily backups with a tested restore).

| Thing              | Where                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Images             | `apps/server/Dockerfile` (targets `runtime`, `migrate`), `apps/web/Dockerfile`                    |
| Stack              | `infra/docker-compose.prod.yml`                                                                   |
| Load balancer      | `infra/nginx/lb.conf` (ip_hash, `/ws` upgrade, `X-Request-Id`)                                    |
| SPA server         | `infra/nginx/web.conf` (cache rules, CSP)                                                         |
| Metrics and alerts | `GET /metrics` on each instance, `infra/prometheus/prometheus.yml`, `infra/prometheus/alerts.yml` |
| CI/CD              | `.github/workflows/deploy.yml`, `.github/workflows/backup-verify.yml`                             |
| Scripts            | `scripts/deploy.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `scripts/test-restore.sh`         |

```
Cloudflare (TLS, DDoS) ─► lb :80 ─┬─ /api /ws /health ─► server-1, server-2 … :3000 ─► Postgres, Redis, S3
                                  └─ everything else  ─► web :8080 (static SPA)
```

The SPA, the API and the socket share **one origin**. The refresh cookie is `SameSite=Lax`, scoped to `/api/auth`, and the client opens `wss://<location.host>/ws`. Splitting them across hostnames breaks login.

---

## 1. First-time host setup

On a Linux host with Docker Engine and the compose plugin:

```bash
sudo mkdir -p /opt/coboard && sudo chown "$USER" /opt/coboard && cd /opt/coboard
# infra/, scripts/deploy.sh and the backup scripts (backup.sh, restore.sh, lib/)
# arrive with each deploy (deploy.yml "Sync deploy files").
# For the first run, copy them from a checkout.
cp infra/env/server.env.example   infra/env/server.env     # fill in every value
cp infra/env/postgres.env.example infra/env/postgres.env   # same password as in DATABASE_URL
mkdir -p infra/secrets && openssl rand -hex 24 > infra/secrets/metrics_token
chmod 600 infra/env/*.env && chmod 644 infra/secrets/metrics_token   # prometheus runs as nobody
# Set METRICS_TOKEN in server.env to the same value as infra/secrets/metrics_token.
docker compose -f infra/docker-compose.prod.yml config >/dev/null   # validates, needs no daemon
```

`server.env` needs `NODE_ENV`-independent values only: `DATABASE_URL` (with `?connection_limit=N`), `REDIS_URL`, two **different** JWT secrets, `CLIENT_ORIGIN` (the public https origin), S3, SMTP, Google OAuth, `METRICS_TOKEN`. The server validates them at boot and names any missing variable (`apps/server/src/lib/env.ts`).

For the CSP, set `CSP_IMG_ORIGINS` (the origin of `S3_PUBLIC_URL`, or of `S3_ENDPOINT`) and `CSP_CONNECT_ORIGINS` (the origin of `S3_ENDPOINT`, plus the read origin) in the shell or a `.env` next to the compose file. Without them, uploaded images are blocked by the browser.

GitHub repository secrets (environment `production`): `DEPLOY_HOST`, `DEPLOY_USER` (in the `docker` group), `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan <host>`), and optionally `DEPLOY_PATH` (defaults to `/opt/coboard`). Until all four required secrets exist, `deploy.yml` builds and pushes images and skips the deploy with a notice.

## 2. Deploy and rollback

**Normal path.** Merge to `main`. Branch protection requires `ci.yml` to pass first. `deploy.yml` then:

1. builds `coboard-server`, `coboard-migrate` and `coboard-web`, and pushes `ghcr.io/<owner>/<image>:<sha>` (plus `:latest`);
2. syncs `infra/`, `scripts/deploy.sh` and the backup scripts to the host, extracting with `tar --overwrite` so the bind-mounted `lb.conf` and Prometheus files change in place;
3. `deploy.sh pull`;
4. `deploy.sh migrate` runs the release command `prisma migrate deploy` **once**, before any instance runs new code;
5. `deploy.sh rollout` restarts `server-1`, waits for it to be healthy, then `server-2`, then `web`, then reloads `lb`. On success it appends the tag to `.deploy-history`.

While one instance restarts, nginx marks it failed and its clients reconnect to another instance. Any instance can serve any board, because Redis pub/sub bridges them (TRD §15.2). Unacked ops replay from each client's outbox, so a restart costs a reconnect and never loses an op.

**Manual deploy** (on the host):

```bash
cd /opt/coboard
TAG=<git sha> bash scripts/deploy.sh all        # pull + migrate + rollout
```

**Rollback.** Pick the previous good tag:

```bash
tail -n 5 /opt/coboard/.deploy-history
TAG=<previous sha> bash scripts/deploy.sh rollout     # no migrate: migrations only go forward
```

Or run **Actions → Deploy → Run workflow** with `tag` set to that SHA. This skips the build and the migration and rolls out the existing images. If `rollout` fails a health check it stops, prints the failing service's logs and prints the rollback command.

**Smoke test after every deploy:**

```bash
curl -fsS https://<host>/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://<host>/        # 200
```

Then open a board in two browsers, draw, and compare the `?debug=1` state hashes (CLAUDE.md §5.1).

### The two web documents

The web build emits `index.html`, which is the S-01 landing page prerendered for `/`, and `app.html`, the SPA shell. `infra/nginx/web.conf` serves `index.html` only for exactly `/` and falls back to `app.html` for every other route. If a host serves `index.html` everywhere, an inline guard drops the landing markup on other paths before first paint, so nothing breaks; but `app.html` avoids sending the 22 KB of landing markup to every route. The CSP hash for every inline script comes from `dist/index.html` at image build (`infra/nginx/csp-hashes.mjs`). `dist/csp-hashes.json` lists the same hashes for any other host.

## 3. Running migrations safely

- Migrations run **only** through the `migrate` image (`docker compose --profile release run --rm migrate`). The server image never migrates on start: N instances would race on the schema, and a bad migration would crash-loop every instance instead of failing one release step.
- **Expand, then contract.** During a rolling deploy, old and new code run against the new schema at the same time. A rollback runs old code against it for longer. So:
  - add columns as nullable or with a default, and add tables freely;
  - rename in three releases: add the new column, then write both and backfill, then drop the old one;
  - drop a column or table only once no deployed release reads it.
- Create migrations in development with `pnpm db:migrate`, commit `apps/server/prisma/migrations/`, and review the SQL. CI applies the migrations to a fresh database on every PR.
- Take an on-demand backup before any migration that rewrites or drops data (§4). Large `CREATE INDEX` statements should be hand-edited to `CONCURRENTLY`, in a migration of their own.
- Check status: `docker compose -f infra/docker-compose.prod.yml --profile release run --rm migrate migrate status --schema prisma/schema.prisma`.
- A failed migration leaves the old release serving traffic, because `rollout` never ran. Fix forward with a new migration. Use `prisma migrate resolve` only once you understand what was partially applied.

## 4. Backups

**Schedule.** Daily at 03:17 UTC from the host's crontab, kept 14 days on local disk. S3 keeps them longer.

```cron
17 3 * * * cd /opt/coboard && set -a && . infra/env/backup.env && bash scripts/backup.sh >>/var/log/coboard-backup.log 2>&1
```

`infra/env/backup.env` (git-ignored, `chmod 600`):

```bash
DATABASE_URL=postgresql://coboard:<pw>@127.0.0.1:5432/coboard   # publish 127.0.0.1:5432 for postgres, or run where it is reachable
BACKUP_DIR=/var/backups/coboard
BACKUP_RETENTION_DAYS=14
BACKUP_S3_BUCKET=coboard-backups
BACKUP_S3_PREFIX=coboard/postgres/
AWS_ACCESS_KEY_ID=…            # write-only key: s3:PutObject on the prefix, nothing else
AWS_SECRET_ACCESS_KEY=…
```

**What `scripts/backup.sh` does.** It runs `pg_dump --format=custom` to `<db>-<UTC stamp>.dump` (written as `.partial` and renamed only when complete), verifies the archive with `pg_restore --list`, and writes a `.sha256` beside it. If `BACKUP_S3_BUCKET` is set, it runs `aws s3 cp`. It then prunes local archives older than the retention window. It prints the archive path on stdout.

**S3 retention is a bucket lifecycle rule**, not the script. A host that can delete backups is a host whose compromise deletes all of them. Set expiry at 35 days on the prefix, turn on versioning, and use Object Lock (governance mode) if available.

**On demand** (before a risky migration):

```bash
cd /opt/coboard && set -a && . infra/env/backup.env && bash scripts/backup.sh
```

The client tools must be version 15 or newer to match the server. The `postgres:15-alpine` image has them: `docker run --rm --network coboard_backend -v /var/backups/coboard:/b postgres:15-alpine pg_dump …` works if the host has no psql.

**Point-in-time.** Daily dumps give an RPO of up to 24 h. Zero committed-op loss (PRD §7.3) between dumps relies on Postgres durability itself. In production, use a managed Postgres with PITR/WAL archiving and a streaming replica (TRD §15.1), and keep these dumps as the independent, provider-agnostic copy.

## 5. Restore procedure

Prefer restoring into a **new** database and repointing the app. That keeps the damaged database for forensics, and `restore.sh` refuses to overwrite production without `--force`.

```bash
cd /opt/coboard
# 1. Stop writes: users get "reconnecting" and their outboxes hold their ops.
docker compose -f infra/docker-compose.prod.yml stop server-1 server-2
# 2. Create the target database.
docker compose -f infra/docker-compose.prod.yml exec postgres createdb -U coboard coboard_restored
# 3. Restore (a local file or an s3:// URL; the .sha256 is checked when present).
PRODUCTION_DATABASE_URL="$DATABASE_URL" \
  bash scripts/restore.sh s3://coboard-backups/coboard/postgres/coboard-20261004T031700Z.dump \
  --target postgresql://coboard:<pw>@127.0.0.1:5432/coboard_restored
#    (or: pnpm db:restore -- <archive> --target <url>)
# 4. Repoint DATABASE_URL in infra/env/server.env at coboard_restored, then
docker compose -f infra/docker-compose.prod.yml --profile release run --rm migrate   # in case the dump predates a migration
docker compose -f infra/docker-compose.prod.yml up -d server-1 server-2
```

`restore.sh` runs `pg_restore --clean --if-exists --single-transaction --exit-on-error`, so a failed restore leaves the target unchanged. Restoring over the live database in place requires `--force`. Even then, take a fresh backup of the live database first.

After a restore, ops acked after the dump's timestamp are gone from the server. Clients still holding them in their outbox replay them on reconnect, and op-id idempotency (R-SYNC-014) prevents duplicates. Say in the incident notes which window was lost.

## 6. Restore drill

Two layers, both automated:

- **Daily in CI.** `.github/workflows/backup-verify.yml`, 04:41 UTC:
  1. Runs `scripts/test-restore.sh` against a fresh Postgres.
  2. If `BACKUP_S3_BUCKET` and a read-only AWS key are configured as secrets, it also restores the **newest production archive**, fails if that archive is more than 26 h old, and checks `Board.currentSeq = max(Operation.seq)` for every board.

  A red run means we may not be able to recover. Treat it as a page.

- **Locally, any time:** `pnpm db:test-restore`. It seeds a known board if the op log is empty, then exports a snapshot of the source with `pg_export_snapshot()`. It fingerprints the source inside that snapshot: rows per table, max seq per board, `currentSeq`, and an md5 of the whole op log. It dumps the same snapshot with `backup.sh`, restores it into a scratch database with `restore.sh`, diffs the two fingerprints and drops the scratch database. It exits non-zero on any difference. Because of the shared snapshot, the comparison is exact even while the source is being written to.

**Quarterly human drill** (record the date and the timings in the incident log):

1. Pull last night's archive from S3 onto a staging host.
2. Follow §5 end to end into a staging database. Time it: this is the real RTO.
3. Start a server against it and open three known boards. Check that the `?debug=1` hashes are stable across two clients.

## 7. Alerts

The rules are in `infra/prometheus/alerts.yml`. The thresholds are from TRD §15.4, and every series comes from `GET /metrics` (documented in `apps/server/src/lib/metrics.ts`). Prometheus scrapes each instance directly with `METRICS_TOKEN`. The load balancer never exposes `/metrics`. For local access to Prometheus, run `ssh -L 9090:127.0.0.1:9090 <host>` and open `localhost:9090/alerts`.

Useful everywhere: `docker compose -f infra/docker-compose.prod.yml ps` (health), `… logs --since 15m server-1 server-2`, and `docker stats`.

| Alert (threshold)                                           | Means                                                                                           | First checks                                                                                                                                                                                                                                                | Mitigation                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **CoBoardHighErrorRate** (5xx > 1%, 5 min)                  | Requests are failing server-side                                                                | Did a deploy just happen (`.deploy-history`)? `logs server-1 server-2 \| grep '"unhandled error"'`. Is Postgres/Redis healthy in `ps`? Which route? `sum by (route) (rate(coboard_http_requests_total{status_class="5xx"}[5m]))`                            | Recent deploy → roll back (§2). DB/Redis down → restart that service and check disk. One route → hotfix forward.                                                                                                                           |
| **CoBoardSlowOpPersist** (op persist p95 > 100 ms)          | The append transaction is slow, so acks are slow, outboxes grow and drawing "lags" for everyone | Postgres CPU/IO (`docker stats`), pool gauges (`coboard_pg_pool_connections`, `coboard_pg_queries_waiting`), `SELECT * FROM pg_stat_activity WHERE state <> 'idle'`, lock waits on `"Board"` rows                                                           | One hot board serialising on its row lock is expected under heavy load, so check whether it is one board. Otherwise raise `connection_limit`, kill runaway queries, give Postgres more IO, or move it to a managed instance.               |
| **CoBoardWebSocketFailures** (upgrade failures > 5%)        | Clients cannot open sockets                                                                     | Break down by reason: `sum by (reason) (rate(coboard_ws_connection_failures_total[5m]))`. `401`: ticket or clock problems, or a JWT secret mismatch between instances. `500`: server logs. `board_full`: a cap hit. Check lb access logs for `/ws` statuses | 401 after a secret change: make sure every instance has the same `server.env` and restart them. A proxy problem (Upgrade headers stripped): check Cloudflare WebSockets is on and `lb.conf` `/ws` is intact.                               |
| **CoBoardConnectedSocketsDropped** (> 50% drop in 5 min)    | Many clients disconnected at once                                                               | Did an instance restart or OOM (`docker ps -a`, `docker inspect --format '{{.State.OOMKilled}}'`)? Lb errors? Is Redis up (fan-out)? Cloudflare status page                                                                                                 | Usually self-heals through client reconnects with jittered backoff. If an instance is crash-looping, roll back. If Redis is down, restart it: presence rebuilds and ops are safe in Postgres.                                              |
| **CoBoardPostgresPoolSaturated** (busy > 80%, per instance) | Queries are about to queue for a connection                                                     | `coboard_pg_queries_waiting`, slow queries in `pg_stat_activity`, whether `connection_limit` in `DATABASE_URL` is still the default estimate                                                                                                                | Raise `connection_limit` while keeping the total across instances under Postgres `max_connections` minus headroom. Add an instance (§8). Put PgBouncer in front if connections are the limit.                                              |
| **CoBoardRedisMemoryHigh** (> 80% of maxmemory)             | Redis is close to evicting                                                                      | `docker compose exec redis redis-cli info memory`, `redis-cli --bigkeys`, key counts by prefix                                                                                                                                                              | Raise `REDIS_MAXMEMORY` (compose env, default 256mb) and recreate redis. Check for keys missing a TTL (a leak). With `volatile-lru`, eviction drops presence and rate-limit buckets but never data.                                        |
| **CoBoardOpRejectionsHigh** (rejected > 0.1% of ops)        | The server is refusing ops: a permissions or validation regression, or abuse                    | `sum by (code) (rate(coboard_ops_rejected_total[5m]))`. Logs: `grep '"op rejected"'`, which gives code, board, actor and correlation id                                                                                                                     | Started with a deploy → roll back: a client/server schema mismatch is the classic cause (R-ARCH-007). One actor → rate limiting is working, so consider revoking their session. `FORBIDDEN` spikes → check for share-link or role changes. |
| **CoBoardJobFailed** (any snapshot/maintenance failure)     | A snapshot, guest sweep, trash purge or image collection threw                                  | `logs \| grep -E '"snapshot failed"\|"(guest_sweep\|trash_purge\|image_collect) failed"'`; for `image_collect`, check that S3 is reachable                                                                                                                  | No data loss: the op log is the source of truth. Snapshot failures make board loads slower as replay tails grow, so fix within a day. Re-runs happen on the next interval.                                                                 |

## 8. Scaling to N instances

Sticky sessions are an optimisation, not a requirement (TRD §15.2): every instance subscribes to the Redis fan-out.

1. `infra/docker-compose.prod.yml`: add `server-3: { <<: *server, hostname: server-3 }`.
2. `infra/nginx/lb.conf`: add `server server-3:3000 max_fails=3 fail_timeout=10s;` to `upstream coboard_api`.
3. `infra/prometheus/prometheus.yml`: add `server-3:3000` to the targets.
4. Deploy normally. `deploy.sh` discovers every `server-N` service, and `rollout` reloads nginx without dropping sockets.

Budget Postgres connections: `instances × connection_limit` must stay well under `max_connections`. Beyond one host, run the same image on several hosts behind the Cloudflare load balancer or a cloud LB with WebSocket support. Postgres and Redis then move to managed services, and nothing in the app changes.

Adding instances under `ip_hash` re-maps some clients. They reconnect once.

## 9. Secret rotation (R-SEC-016)

A secret that reached a commit, a log, a screenshot or a chat is **compromised**. Rotate it. Reverting the commit is not enough.

| Secret                               | Rotate                                                                                                                | Effect                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`                  | New value (`openssl rand -base64 48`) in `server.env`, then `deploy.sh rollout` with the current tag                  | Access tokens are invalid. Clients silently refresh (15-minute tokens) |
| `JWT_REFRESH_SECRET`                 | Same                                                                                                                  | Every user is signed out. Do it when compromise is suspected           |
| Postgres password                    | `ALTER ROLE coboard PASSWORD '…'`, then update `postgres.env` and `DATABASE_URL`, then roll the servers               | Brief reconnects                                                       |
| `METRICS_TOKEN`                      | Update `server.env` and `infra/secrets/metrics_token` together, roll the servers, `docker compose restart prometheus` | A metrics gap of a few seconds                                         |
| S3 / SMTP / Google OAuth credentials | Issue a new key at the provider, update `server.env`, roll the servers, **then** revoke the old key                   | None                                                                   |
| Deploy SSH key                       | New key pair, add it to `authorized_keys`, update `DEPLOY_SSH_KEY`, remove the old key from the host                  | None                                                                   |
| AWS backup keys                      | Rotate in IAM, update `backup.env` or the GitHub secrets                                                              | None                                                                   |

Keep the two JWT secrets different. The server refuses to boot if they are equal. After an exposure, also purge the value from git history if the repo is shared, and check access logs for the exposure window.

## 10. Logs and following a request end to end

- **Where.** Each container logs to stdout, and Docker keeps the logs (`json-file`, 5 × 50 MB per container). Use `docker compose -f infra/docker-compose.prod.yml logs -f --since 1h server-1 server-2 lb`. Server lines are pino JSON. Lb lines are JSON (`log_format coboard`). Ship both to a log store if one is adopted.
- **Correlation id.** The web client mints an id per API call and sends it as `x-request-id`. `lb.conf` keeps a well-formed id or mints one (`$request_id`) and forwards it. The server keeps it as well. Its pattern is the same as the lb's, so the id stays the same. Every server log line for that request carries it as `requestId`, it is returned in the `x-request-id` response header, and it is the `correlationId` of any error envelope, which the UI shows as **"Ref: …"**.
- **Following one.** The user quotes `Ref: 3f9a1c2e`:

  ```bash
  docker compose -f infra/docker-compose.prod.yml logs --since 24h lb server-1 server-2 | grep 3f9a1c2e
  ```

  The lb line gives the status, the timing and which instance served the request (`upstream`). The server lines give the error and its stack.

- **Socket ops** carry `correlationId` `<sessionId>:<opId>` in the `"op rejected"` log lines. Grep the op id from the client's debug panel, or the session id.

## 11. Manual steps not done from the build container

These steps need accounts or a Docker daemon. None can be done or verified from the development container.

1. **Build the images for real.** No daemon was available, so the Dockerfiles were validated by reproducing their steps natively, not by `docker build`. The first `deploy.yml` run is the real build. Watch it.
2. **Provision the host:** Docker, a firewall that allows only 22 and the Cloudflare ranges on 80/443, and §1.
3. **Cloudflare:**
   - Proxied DNS record for the app hostname, with SSL mode **Full (strict)**: install a Cloudflare Origin CA certificate, add a `listen 8443 ssl;` server block with `ssl_certificate`/`ssl_certificate_key` to `lb.conf`, mount the certificate into the `lb` service (e.g. `./secrets/origin-ca:/etc/nginx/certs:ro`) and publish `443:8443` in `docker-compose.prod.yml`. Or use a tunnel (`cloudflared`), which needs none of that.
   - Network → **WebSockets: on**.
   - "Always Use HTTPS" and HSTS. `web.conf` already sends `max-age=31536000; includeSubDomains`; add `preload` only once every subdomain is HTTPS.
   - Generate `cloudflare-realip.conf` and uncomment the real-IP block in `lb.conf`. Without it, `ip_hash` and per-IP rate limits see Cloudflare's IPs.
   - Cache rule: bypass `/api/*` and `/ws`. Static assets can be cached; the origin already sends `immutable`.
4. **Managed Postgres with a replica and PITR, S3 buckets** (uploads with a CORS rule allowing `PUT`/`GET` from `CLIENT_ORIGIN` and the request headers `content-type` and `content-disposition` — SVG presigns sign `Content-Disposition: attachment` (security review finding 6), so a rule without it fails every SVG upload in the browser; backups with lifecycle, versioning and a write-only key), and SMTP and Google OAuth credentials.
5. **GitHub:** the `production` environment with required reviewers if wanted, the deploy secrets (§1), the backup-verify secrets (§6), and branch protection on `main` requiring CI.
6. **Alert routing:** an Alertmanager or Grafana contact point (see `infra/prometheus/prometheus.yml`), plus an external uptime check on `https://<host>/health` for the 99.5% SLO.
7. **First deploy and smoke test** (§2), then the first quarterly restore drill (§6).
