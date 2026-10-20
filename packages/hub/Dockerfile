# syntax=docker/dockerfile:1
# sessiondeck hub image. Build context is the repository root:
#   docker build -f packages/hub/Dockerfile -t sd-hub:dev .
# Base is pinned by tag (multi-arch, includes linux/arm64). Follow-up: pin by digest
# (node:22-bookworm-slim@sha256:...) once a release process can resolve digests online.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
# better-sqlite3 is compiled from source (no prebuilt binary is downloaded and trusted).
# The toolchain exists in this stage only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ENV npm_config_build_from_source=true CI=true
WORKDIR /repo
# Same pnpm as the root package.json packageManager field.
COPY package.json ./
RUN corepack enable \
 && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contract/package.json packages/contract/package.json
COPY packages/hub/package.json packages/hub/package.json
# "." is the workspace root (esbuild is its devDependency); the hub filter brings in its workspace deps.
RUN pnpm install --frozen-lockfile --filter . --filter "@sessiondeck/hub..."
COPY packages/contract packages/contract
COPY packages/hub packages/hub
WORKDIR /repo/packages/hub
RUN node scripts/bundle.mjs src/main.ts dist/main.mjs
# Production dependencies only (the packages the bundle leaves external), compiled in place.
WORKDIR /repo
RUN pnpm --filter @sessiondeck/hub deploy --prod --legacy /out \
 && cp packages/hub/dist/main.mjs /out/main.mjs \
 && node -e "require('/out/node_modules/better-sqlite3')"

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HUB_DB_PATH=/data/hub.sqlite \
    HUB_PORT=8787
RUN groupadd --gid 10001 hub \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hub \
 && mkdir /data /app \
 && chown 10001:10001 /data
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/main.mjs ./dist/main.mjs
USER 10001:10001
VOLUME /data
EXPOSE 8787
# Loopback inside the container; not an outbound call. /health needs no token.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HUB_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# HUB_TOKEN is required at run time (never baked in). HUB_BIND defaults to 127.0.0.1 (D-S3-4);
# set HUB_BIND=0.0.0.0 to be reachable from outside the container.
CMD ["node", "dist/main.mjs"]
