# Sprint container image: runs one mini-sprint orchestrator headless.
# Specification: infra/sprint/README.md. Build context is infra/sprint only.
#
# Secrets rule: no ARG, ENV, LABEL, COPY or RUN step here carries or reads a
# token. Tokens reach the container at run time through the compose env_file.
# Do not set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or apiKeyHelper: they rank
# above CLAUDE_CODE_OAUTH_TOKEN and would silently bill the API instead of the
# subscription.

# Pinned tag (not a floating "22") so rebuilds are reproducible. The full
# (not slim) image is used because it already carries ca-certificates, which
# apt needs to reach the mirrors over https (next step), and the compilers that
# node-gyp falls back to when a native addon has no prebuilt binary.
FROM node:22.23.3-bookworm

# Versions. PNPM_VERSION must equal the root package.json packageManager field
# (scripts/test/sprint-image-static.test.ts enforces this).
ARG CLAUDE_CODE_VERSION=2.1.295
ARG PNPM_VERSION=12.10.1
# Only used to install the browsers' system libraries; browsers themselves are
# downloaded by each project's own playwright install.
ARG PLAYWRIGHT_VERSION=1.56.1
ARG SPRINT_UID=1000

ENV DEBIAN_FRONTEND=noninteractive

# Fetch Debian packages over https. Plain http is rewritten by captive portals
# (hotel and campus Wi-Fi) into HTML, which makes apt-get update fail.
RUN sed -i "s|http://|https://|g" /etc/apt/sources.list.d/debian.sources

# git, jq and bash for the entrypoint and sessions; util-linux provides setpriv.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git gnupg jq procps util-linux \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI and the Docker CLI (client and compose plugin only, no daemon) from
# their vendors' signed apt repositories.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli.gpg \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# pnpm, Claude Code (the npm package ships the same native binary as the
# standalone installer) and Playwright's system libraries.
RUN npm install -g "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# --dangerously-skip-permissions is refused for root, so sessions run as a
# non-root user. The base image's own "node" user is replaced so the uid is ours.
RUN userdel -r node \
 && groupadd --gid "${SPRINT_UID}" sprint \
 && useradd --uid "${SPRINT_UID}" --gid sprint --create-home --shell /bin/bash sprint \
 && install -d -o sprint -g sprint /work /state /home/sprint/.claude

# Auto-update would replace the pinned version at run time.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/home/sprint/.claude \
    HOME=/home/sprint \
    GIT_TERMINAL_PROMPT=0 \
    GH_PROMPT_DISABLED=1

# CR is stripped as a second defense against a CRLF checkout on Windows.
COPY entrypoint.sh /usr/local/bin/sprint-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/sprint-entrypoint \
 && chmod 0755 /usr/local/bin/sprint-entrypoint

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/sprint-entrypoint"]
