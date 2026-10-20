# syntax=docker/dockerfile:1
# sessiondeck web image: static build served by nginx-unprivileged. Build context is the repo root:
#   docker build -f infra/web/Dockerfile -t sd-web:dev .
# Bases are pinned by tag and are multi-arch (linux/amd64 and linux/arm64). DEFERRED: pin by index
# digest once a release process can resolve it online (same note as packages/hub/Dockerfile).
# The hub URL is not a build input: the UI takes it at run time (Settings, stored in the browser).
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${NODE_IMAGE} AS build
ENV CI=true
WORKDIR /repo
COPY package.json ./
RUN corepack enable \
 && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contract/package.json packages/contract/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --filter . --filter "@sessiondeck/web..."
# Explicit file list, never whole directories: untracked files (fixtures/raw, .env, data/*.sqlite)
# must not be reachable by COPY (the legacy builder ignores Dockerfile.dockerignore).
# The web build runs `tsc --noEmit`, whose tsconfig includes scripts, e2e and the config files.
COPY packages/contract/tsconfig.json packages/contract/tsconfig.json
COPY packages/contract/src packages/contract/src
COPY packages/web/tsconfig.json packages/web/index.html packages/web/vite.config.ts \
     packages/web/tailwind.config.ts packages/web/postcss.config.js packages/web/playwright.config.ts \
     packages/web/
COPY packages/web/src packages/web/src
COPY packages/web/scripts packages/web/scripts
COPY packages/web/e2e/*.ts packages/web/e2e/
RUN pnpm -F @sessiondeck/web build

FROM ${NGINX_IMAGE} AS runtime
COPY infra/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/packages/web/dist /usr/share/nginx/html
EXPOSE 8080
# nginx-unprivileged already runs as uid 101.
