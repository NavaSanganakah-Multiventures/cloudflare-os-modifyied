# Build/test sandbox image for the Cloudflare OS container runner.
#
# Cloudflare Containers require linux/amd64. This image provides Node, pnpm, and common build
# tooling so the agent can run commands like "pnpm install" and "pnpm run build" against code it
# streams in at runtime via container.exec(). It runs a trivial health server on :8080 so the
# Container class's port-readiness check has something to probe (see BuildContainer in
# packages/workshop-backend/src/container-runner.ts).

FROM node:22-bookworm

# pnpm, pinned to the version the monorepo expects (see root package.json "packageManager").
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

# Common build tooling: git (clones), native-dependency helpers, python (node-gyp).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        build-essential \
        python3 \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Minimal health server on :8080 returning "ok". Real work is driven via container.exec(); this
# process only exists to satisfy the port-readiness check during start().
RUN printf '%s\n' \
        'import http from "node:http";' \
        'http.createServer((_req, res) => {' \
        '  res.writeHead(200, { "content-type": "text/plain" });' \
        '  res.end("ok");' \
        '}).listen(8080);' \
    > /usr/local/bin/health-server.mjs

EXPOSE 8080
CMD ["node", "/usr/local/bin/health-server.mjs"]
