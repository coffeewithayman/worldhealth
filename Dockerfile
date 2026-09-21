# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain fallback for native deps (better-sqlite3 ships prebuilt binaries
# for glibc, but keep a build fallback in case a version lacks one for this arch).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/store/package.json packages/store/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json

RUN npm ci

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY config ./config

RUN npm run build \
    && npm -w @wd/web exec tsc -- --noEmit \
    && npm -w @wd/web run build

# ---- runtime stage ----------------------------------------------------------
# One image, two roles, chosen by the start command:
#   API   node packages/api/dist/server.js       (default CMD)
#   cron  node packages/ingest/dist/cli.js daily
#   migrate (pre-deploy) node packages/ingest/dist/cli.js migrate
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WD_LOG_FORMAT=json \
    WD_LOG_LEVEL=info
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/store/package.json packages/store/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/ingest/package.json packages/ingest/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json

# Production deps only, but keep the workspace symlinks (node_modules/@wd/*)
# that let compiled dist/ files resolve sibling packages at runtime.
RUN npm ci --omit=dev --workspaces --include-workspace-root

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/store/dist packages/store/dist
COPY --from=build /app/packages/connectors/dist packages/connectors/dist
COPY --from=build /app/packages/ingest/dist packages/ingest/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/config ./config

USER node
EXPOSE 8787

# No HEALTHCHECK: this one image runs both the API and the one-shot cron job,
# which has no server to probe. The platform checks the API itself
# (railway.api.toml → /healthz).

CMD ["node", "packages/api/dist/server.js"]
