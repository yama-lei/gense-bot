# The server image (ADR-0005 decision 13). The sandbox images are separate: sandbox/Dockerfile.
FROM docker:29.6.2-cli AS docker

FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
# @openuidev/lang-core's postinstall sends install statistics unless this is set.
ENV OPENUI_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-trixie-slim
# The server starts and stops sandbox containers through the host's Docker socket; it needs only the client.
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production NODE_NO_WARNINGS=1 HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "packages/server/src/platform/main.ts"]
