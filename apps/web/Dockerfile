# syntax=docker/dockerfile:1.7
#
# CoBoard SPA — built with Vite, served by unprivileged nginx on :8080.
#
# Build from the REPO ROOT:
#   docker build -f apps/web/Dockerfile -t coboard-web .
#
# Runtime environment (all optional, see infra/nginx/web.conf):
#   CSP_IMG_ORIGINS, CSP_CONNECT_ORIGINS — the S3 / CDN origins for images.

ARG NODE_VERSION=20

# ── build ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @coboard/web...

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY infra/nginx/csp-hashes.mjs /tmp/csp-hashes.mjs
# Source maps would publish the original source, so they are dropped here
# (upload them to an error tracker from CI instead, if one is adopted).
RUN pnpm --filter @coboard/web build \
 && find apps/web/dist -name '*.map' -delete \
 && node /tmp/csp-hashes.mjs apps/web/dist/index.html > /tmp/csp-hashes.conf

# ── runtime ──────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV NGINX_ENVSUBST_FILTER=CSP_ \
    CSP_IMG_ORIGINS="" \
    CSP_CONNECT_ORIGINS=""
COPY infra/nginx/web.conf /etc/nginx/templates/default.conf.template
COPY --from=build /tmp/csp-hashes.conf /etc/nginx/snippets/csp-hashes.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
