FROM python:3.12-slim

WORKDIR /app

# System deps for pyodbc (SQL Server), psycopg2, plus a baseline shell toolset
# the in-container Claude Code agent relies on for diagnostics / file ops:
#   procps     → ps
#   util-linux → lsblk, mount, umount, fsck, …
#   findutils  → find, xargs
#   coreutils  → ls, cp, mv, rm, cat, df, du, chmod, chown, … (in the base image,
#                pinned here so the toolset is explicit and never trimmed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ unixodbc-dev curl gnupg2 \
    procps util-linux findutils coreutils grep \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Copy dependency files first (cache layer)
COPY pyproject.toml ./

# Install CPU-only torch first so sentence-transformers does not pull CUDA wheels.
# The PyTorch CPU index ships BOTH x86_64 and aarch64 CPU wheels, so this builds
# natively on amd64 (Railway/VM) and arm64 (Apple Silicon — no Rosetta) alike.
# (Plain PyPI torch on aarch64 now resolves the CUDA/GH200 build and pulls huge
# nvidia-*-cu* wheels, so the CPU index is required here.)
RUN uv pip install --system --no-cache \
    --index-url https://download.pytorch.org/whl/cpu torch

# Install dependencies
RUN uv pip install --system --no-cache -r pyproject.toml

# ── Oracle Instant Client (THICK mode) ──────────────────────────────────────
# python-oracledb's pure-Python THIN mode cannot authenticate accounts that use
# legacy password verifiers (DPY-3015), which the on-prem Oracle uses. THICK
# mode needs the Instant Client native libs. Arch-aware so the image builds on
# both arm64 (Apple Silicon) and amd64 (Railway/CI). The connector auto-detects
# /opt/oracle/instantclient at import and switches to THICK mode.
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends unzip; \
    (apt-get install -y --no-install-recommends libaio1t64 \
        || apt-get install -y --no-install-recommends libaio1); \
    rm -rf /var/lib/apt/lists/*; \
    # Debian trixie ships libaio.so.1t64; Instant Client links libaio.so.1.
    for d in /lib/*/ /usr/lib/*/; do \
        if [ -e "${d}libaio.so.1t64" ] && [ ! -e "${d}libaio.so.1" ]; then \
            ln -sf "${d}libaio.so.1t64" "${d}libaio.so.1"; \
        fi; \
    done; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
        arm64) IC_ARCH=arm64 ;; \
        amd64) IC_ARCH=x64 ;; \
        *) echo "unsupported arch for Instant Client: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/oracle; \
    curl -fsSL -o /tmp/ic.zip \
        "https://download.oracle.com/otn_software/linux/instantclient/1925000/instantclient-basic-linux.${IC_ARCH}-19.25.0.0.0dbru.zip"; \
    unzip -q /tmp/ic.zip -d /opt/oracle; \
    rm /tmp/ic.zip; \
    ln -sfn /opt/oracle/instantclient_19_25 /opt/oracle/instantclient; \
    echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf; \
    ldconfig

# ── Claude Code (Anthropic agentic CLI) for the admin skill enhance-loop ─────
# Official native installer (no Node). Symlinked onto PATH so the uvicorn
# process and any spawned shell resolve `claude`. Auth at runtime via
# CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY.
# Installed in this late layer (not pyproject) so the heavy torch/deps layers
# stay cached. `mcp` backs the Brikz MCP server used by the enhance-loop.
ENV CLAUDE_CONFIG_DIR=/app/.claude
RUN set -eux; \
    uv pip install --system --no-cache "mcp>=1.2.0"; \
    mkdir -p /app/.claude; \
    curl -fsSL https://claude.ai/install.sh | bash; \
    ln -sf /root/.local/bin/claude /usr/local/bin/claude; \
    claude --version

# Copy application code
COPY . .

# Create data directories
RUN mkdir -p data/subagents data/outputs logs

# Save a baked copy of /app/data OUTSIDE the future volume mount point, so the
# entrypoint can seed it into a (Railway) volume mounted at /app/data without
# the empty mount masking baked content (data/classes, data/cte_graphs, …).
RUN cp -a /app/data /opt/brikz-seed-data && chmod +x docker-entrypoint.sh

EXPOSE 8000

# Seed the volume from the baked copy (no-clobber), then start uvicorn.
CMD ["sh", "/app/docker-entrypoint.sh"]
