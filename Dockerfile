# The server image (ADR-0005 decision 13). The sandbox images are separate: sandbox/Dockerfile.
# Base images are pinned by digest, so a cached build needs no registry lookup; update the digest with the tag.
FROM docker:29.6.2-cli@sha256:be132a9f282288de4afaf63379dff75711fda0147c6b72a9df44e51841402144 AS docker

# Manifests only: the dependency stages below re-run only when a package.json or the lockfile changes.
FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS manifests
WORKDIR /app
# @openuidev/lang-core's postinstall sends install statistics unless this is set.
ENV OPENUI_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/web/package.json packages/web/

# The server's production dependencies, without the web bundle's packages.
FROM manifests AS deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev -w @gense/server -w @gense/protocol --include-workspace-root=false

# The web bundle. Type checking stays in `npm run check`; the image only needs vite's output.
FROM manifests AS web
RUN --mount=type=cache,target=/root/.npm npm ci
COPY packages/protocol packages/protocol
COPY packages/web packages/web
RUN cd packages/web && npx vite build

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
# Skill Git installs run on the host process; keep Git and HTTPS trust in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
# The server starts and stops sandbox containers through the host's Docker socket.
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
# Separate layers, dependencies first: a code change rewrites only the small source layers.
COPY --from=deps /app /app
COPY packages/protocol packages/protocol
COPY packages/server packages/server
COPY --from=web /app/packages/web/dist packages/web/dist
ENV NODE_ENV=production NODE_NO_WARNINGS=1 HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "packages/server/src/platform/main.ts"]
