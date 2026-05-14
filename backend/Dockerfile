FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage uses Debian slim so Claude Code CLI's bundled ripgrep
# and native deps run on glibc (smoother than musl).
FROM node:20-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally. OAuth credentials are mounted at
# runtime from the host (~/.claude → /root/.claude), so no API key needed.
RUN npm install -g @anthropic-ai/claude-code

COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/main"]
