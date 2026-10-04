# syntax=docker/dockerfile:1.7
#
# CoBoard API + WebSocket server — TRD §15.1.
#
# Build from the REPO ROOT (the pnpm workspace and lockfile live there):
#
#   docker build -f apps/server/Dockerfile -t coboard-server .                    # runtime
#   docker build -f apps/server/Dockerfile --target migrate -t coboard-migrate .  # release
#
# Two images, on purpose:
#   runtime  — `node dist/index.js`. Production dependencies only. Never runs
#              migrations: N instances starting at once must not race each
#              other on the schema, and a bad migration must fail the RELEASE,
#              not crash-loop every instance.
#   migrate  — `prisma migrate deploy`, run ONCE per release before the new
#              runtime image is rolled out (docs/RUNBOOK.md §2).

ARG NODE_VERSION=20

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS base
# openssl: Prisma's query engine links against it (linux-musl-openssl-3.0.x).
# tini:    PID 1 that forwards SIGTERM, so `docker stop` ends node promptly
#          instead of waiting out the 10 s kill timeout.
RUN apk add --no-cache openssl tini
# pnpm at the exact version pinned in package.json#packageManager.
RUN corepack enable
WORKDIR /repo

# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
ENV CI=true
# Manifests first, so the dependency layer is cached until the lockfile moves.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @coboard/server exec prisma generate \
 && pnpm --filter @coboard/server build

# Self-contained copies of the server package with workspace deps injected
# (packages/shared arrives as a real directory, with its dist/).
#   /out     — production dependencies only, for the runtime image
#   /migrate — includes devDependencies, because the prisma CLI is one
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --config.inject-workspace-packages=true --filter @coboard/server deploy --prod /out \
 && pnpm --config.inject-workspace-packages=true --filter @coboard/server deploy /migrate
# `deploy` does not carry the generated client over, so generate it into the
# runtime copy (the migrate image needs only the CLI and the migrations).
RUN cd /out && /repo/apps/server/node_modules/.bin/prisma generate --schema prisma/schema.prisma \
 && rm -rf /out/src /out/dist/__tests__ /out/tsconfig.json

# ── migrate (release command) ────────────────────────────────────────────────
FROM base AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /migrate/package.json ./package.json
COPY --from=build --chown=node:node /migrate/prisma ./prisma
COPY --from=build --chown=node:node /migrate/node_modules ./node_modules
USER node
# Needs DATABASE_URL. Idempotent: applies only migrations not yet recorded.
ENTRYPOINT ["/sbin/tini", "--", "node_modules/.bin/prisma"]
CMD ["migrate", "deploy", "--schema", "prisma/schema.prisma"]

# ── runtime (default target) ─────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# The image ships no .env: every setting comes from the environment
# (R-SEC-016). src/lib/env.ts names any missing variable at boot.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# --conditions=coboard-dist resolves @coboard/shared to its compiled dist/
# instead of its TypeScript source, which Node 20 cannot load
# (packages/shared/package.json#exports).
CMD ["node", "--conditions=coboard-dist", "--enable-source-maps", "dist/index.js"]
