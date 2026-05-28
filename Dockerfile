# syntax=docker/dockerfile:1.6

# ---- build stage --------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy lockfile + manifest first so this layer caches between source edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime stage ------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# tini is a tiny init that reaps zombies and forwards SIGTERM cleanly.
RUN apk add --no-cache tini wget && \
    addgroup -S app && adduser -S app -G app

# Copy production deps from the build stage and the source from the build context.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js addon.js config.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public

# Persist event cache to a volume so refreshes survive container recreates.
RUN mkdir -p /app/data && chown -R app:app /app
VOLUME ["/app/data"]

USER app

ENV NODE_ENV=production \
    PORT=7000 \
    HOST=0.0.0.0 \
    DATA_FILE=/app/data/events.json

EXPOSE 7000

# Healthcheck hits the dedicated /health endpoint so it works even if the
# event cache is still being populated on first boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7000/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
