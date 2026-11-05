# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json ./
COPY frontend ./frontend
COPY backend ./backend
COPY shared ./shared
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# Optional tooling peers (including drizzle-kit/tsx) are not used by compiled code.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
# EPUB uses Python; text PDFs use pdftotext. curl supports Coolify health checks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 poppler-utils \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    LOREFOLD_STORAGE_MODE=r2 \
    LOREFOLD_AI_MODE=mock \
    LOREFOLD_IMPORT_LIVE=0 \
    LOREFOLD_CHATGPT_PERSONAL=0 \
    IMPORT_CONCURRENCY=1
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
USER node

# Select this target for the private background worker in Coolify.
FROM runtime AS worker
# Coolify beta.431 detects checks across all stages, so each target needs its own.
# Keep timing options identical because that version parses only the first check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "dist/server/backend/imports/healthcheck.js"]
CMD ["node", "dist/server/backend/imports/index.js"]

# The default target serves the frontend and API from one process.
FROM runtime AS web
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent --show-error --max-time 4 "http://127.0.0.1:${PORT}/api/health" || exit 1
# Fail the deployment if migrations fail; exec forwards shutdown signals to Node.
CMD ["sh", "-c", "node dist/server/scripts/migrate.js && exec node dist/server/backend/index.js"]
