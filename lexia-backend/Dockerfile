# syntax=docker/dockerfile:1.6

FROM node:20-bookworm-slim AS node-builder

WORKDIR /app

COPY lexia-backend/package.json lexia-backend/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY lexia-backend/tsconfig.json lexia-backend/tsconfig.build.json lexia-backend/nest-cli.json ./
COPY lexia-backend/src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV PORT=4000 \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    poppler-utils \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/dist ./dist
COPY --from=node-builder /app/package.json ./package.json
COPY --from=node-builder /app/src ./src
COPY --from=node-builder /app/tsconfig.json ./tsconfig.json
COPY lexia-backend/scripts ./scripts

# Chromium for the mahakim.ma headless scraper (Playwright). Installs the
# browser + its system libraries into the default cache (/root/.cache).
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN node_modules/.bin/playwright install --with-deps chromium

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --retries=5 --start-period=90s \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1

CMD ["sh", "-c", "node_modules/.bin/auth migrate --yes && node scripts/seed-admin.mjs && node dist/main.js"]
