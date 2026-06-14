#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Qclick deploy helper — implements deploy/DEPLOY.md as a single script.
#
# Usage:
#   ./deploy/deploy.sh <command> [--vm <user@host>] [--version <tag>]
#
# Commands:
#   build         Build backend image + frontend dist (Mac)
#   ship          scp image, config, compose, and rsync dist to the VM
#   install       Load image on VM, update VERSION, recreate backend container
#   verify        Run the 4-check smoke test against the VM
#   all           build → ship → install → verify (full release)
#   firewall      Open BACKEND_PORT/tcp via firewalld on the VM
#   compare       Run compare_parquet_oracle.py inside the VM container
#                 (ships the script, docker-cp's it, forwards trailing args).
#                 Example: ./deploy.sh compare --preset sum_by_year
#   rollback      Switch VM to an older VERSION already loaded on the host
#   logs          Tail backend logs on the VM
#
# Environment variables (override defaults or CLI flags):
#   VERSION          release tag, e.g. 2026.04.21
#   VM_HOST          VM IP or hostname
#   VM               full "user@host" (default: uadmin@$VM_HOST)
#   BACKEND_PORT     host-side API port (default: 6002)
#   VITE_API_URL     full URL the frontend should hit (default: http://$VM_HOST:$BACKEND_PORT)
#   VITE_BASE        nginx subpath (default: /qclick/)
#   REPO_ROOT        repo checkout (default: script's parent dir)
#   CHAT_DIST_DIR    Vite output (default: $REPO_ROOT/qclick-chat/dist)
#   REMOTE_CHAT_ROOT rsync destination on the VM (default: /data/qclick/chat)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REPO_ROOT:=$(cd "$SCRIPT_DIR/.." && pwd)}"
AGENT_DIR="$REPO_ROOT/qclick-agent"
CHAT_DIR="$REPO_ROOT/qclick-chat"
CHAT_DIST_DIR="${CHAT_DIST_DIR:-$CHAT_DIR/dist}"
DEPLOY_DIR="$REPO_ROOT/deploy"
DIST_DIR="$AGENT_DIR/release/dist"
: "${REMOTE_CHAT_ROOT:=/data/qclick/chat}"

# ── CLI parsing ───────────────────────────────────────────────────────────────
COMMAND="${1:-}"
shift || true
# Anything after the command that isn't a known deploy-flag is collected into
# EXTRA_ARGS — commands like `compare` forward them to the inner tool.
EXTRA_ARGS=()
while (($#)); do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --vm)      VM="$2"; shift 2 ;;
        --vm-host) VM_HOST="$2"; shift 2 ;;
        --port)    BACKEND_PORT="$2"; shift 2 ;;
        -h|--help|help) COMMAND="help"; shift ;;
        --) shift; EXTRA_ARGS+=("$@"); break ;;
        *)
            # For pass-through commands, keep unknown args instead of erroring.
            if [[ "$COMMAND" == "compare" ]]; then
                EXTRA_ARGS+=("$1"); shift
            else
                echo "Unknown flag: $1" >&2; exit 2
            fi
            ;;
    esac
done

# `compare` can run without VERSION (nothing gets built); everything else needs it.
if [[ "$COMMAND" != "compare" && "$COMMAND" != "help" && -n "$COMMAND" ]]; then
    : "${VERSION:?VERSION not set (use --version or export VERSION)}"
fi
: "${VERSION:=latest}"
: "${VM_HOST:=}"
: "${VM:=${VM_HOST:+uadmin@$VM_HOST}}"
: "${BACKEND_PORT:=6002}"
# Without a hostname, URLs like http://:6002 break the browser (Invalid URL).
: "${VITE_API_URL:=http://${VM_HOST:-localhost}:${BACKEND_PORT}}"
: "${VITE_BASE:=/qclick/}"

IMAGE_TAG="qclick-agent:$VERSION"
IMAGE_TAR="$DIST_DIR/qclick-agent-$VERSION.tar.gz"

# ── Helpers ───────────────────────────────────────────────────────────────────
c_grn='\033[1;32m'; c_ylw='\033[1;33m'; c_red='\033[1;31m'; c_dim='\033[2m'; c_rst='\033[0m'
say()  { printf "${c_grn}▶ %s${c_rst}\n" "$*"; }
warn() { printf "${c_ylw}⚠ %s${c_rst}\n" "$*"; }
die()  { printf "${c_red}✗ %s${c_rst}\n" "$*" >&2; exit 1; }

require_vm() { [[ -n "${VM:-}" ]] || die "VM not set. Pass --vm user@host or export VM_HOST"; }

# Reuse one SSH connection for the whole script run — avoids retyping the password
# at every scp/ssh step. Requires OpenSSH ControlMaster support (standard on macOS).
#
# NOTE: Unix-domain socket paths are capped at ~104 bytes on macOS. macOS $TMPDIR
# (/var/folders/.../T/) is already ~53 chars, so using it blows the limit. We put
# the socket under ~/.ssh/ (short, guaranteed writable) and use %C — a 16-char
# hash of user+host+port — to keep the basename small and valid.
SSH_CTRL_DIR="$HOME/.ssh/cm"
mkdir -p "$SSH_CTRL_DIR" && chmod 700 "$SSH_CTRL_DIR"
SSH_OPTS=(-o "ControlMaster=auto" -o "ControlPath=$SSH_CTRL_DIR/%C" -o "ControlPersist=10m")
trap 'ssh "${SSH_OPTS[@]}" -O exit "${VM:-dummy}" 2>/dev/null || true' EXIT

ssh_vm()  { ssh "${SSH_OPTS[@]}" "$VM" "$@"; }
scp_vm()  { scp "${SSH_OPTS[@]}" "$@"; }
rsync_vm(){ rsync -av --delete -e "ssh ${SSH_OPTS[*]}" "$@"; }

# Wait until /health returns 200, up to ~60s.
wait_healthy() {
    local base="http://$VM_HOST:$BACKEND_PORT"
    local max="${1:-60}"
    for ((i=1; i<=max; i++)); do
        if curl -sSf --max-time 2 "$base/health" >/dev/null 2>&1; then
            say "backend healthy after ${i}s"
            return 0
        fi
        sleep 1
    done
    return 1
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_help() {
    sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
}

cmd_build() {
    say "Build backend image: $IMAGE_TAG"
    make -C "$AGENT_DIR" release-build VERSION="$VERSION"

    say "Sanity check: image exists"
    docker image inspect "$IMAGE_TAG" >/dev/null || die "Image $IMAGE_TAG not found after build"

    say "Smoke test: Oracle thick mode"
    docker run --rm --platform linux/amd64 "$IMAGE_TAG" python -c "
import services.connectors.oracle_connector, oracledb
assert not oracledb.is_thin_mode(), 'thick mode did not engage'
print('thick_mode OK', oracledb.clientversion())" \
        || die "Thick-mode smoke test failed"

    say "Export image tarball → $IMAGE_TAR"
    mkdir -p "$DIST_DIR"
    docker save "$IMAGE_TAG" | gzip >"$IMAGE_TAR"
    [[ $(stat -f %z "$IMAGE_TAR" 2>/dev/null || stat -c %s "$IMAGE_TAR") -gt 10000000 ]] \
        || die "Exported tarball looks truncated: $(ls -lh "$IMAGE_TAR")"
    ls -lh "$IMAGE_TAR"

    if [[ -z "${VM_HOST:-}" ]]; then
        warn "VM_HOST unset — frontend will be built with VITE_API_URL=$VITE_API_URL. For production, export VM_HOST=<browser-reachable host> before build (or set VITE_API_URL explicitly)."
    fi

    say "Build frontend dist (VITE_API_URL=$VITE_API_URL  VITE_BASE=$VITE_BASE)"
    printf 'VITE_API_URL=%s\nVITE_BASE=%s\n' "$VITE_API_URL" "$VITE_BASE" > "$CHAT_DIR/.env.production"
    (cd "$CHAT_DIR" && npm ci && npm run build)

    say "Verify frontend uses ${VITE_BASE}… paths"
    if ! grep -Eoq "$VITE_BASE"'[^"]*' "$CHAT_DIR"/dist/assets/*.js 2>/dev/null; then
        warn "No '$VITE_BASE' references found in built JS — check .env.production"
    fi

    say "Build complete."
}

cmd_ship() {
    require_vm
    [[ -f "$IMAGE_TAR" ]] || die "Missing $IMAGE_TAR — run '$0 build' first"

    say "Warm SSH connection (one password prompt for the whole session)"
    ssh_vm true

    say "Ensure remote directories exist"
    ssh_vm "mkdir -p /data/qclick/deploy/config $REMOTE_CHAT_ROOT"

    say "scp image → $VM:/data/qclick/"
    scp_vm "$IMAGE_TAR" "$VM:/data/qclick/"

    say "scp deploy/config/*.yaml"
    scp_vm "$DEPLOY_DIR"/config/*.yaml "$VM:/data/qclick/deploy/config/"

    say "scp docker-compose.yml"
    scp_vm "$DEPLOY_DIR/docker-compose.yml" "$VM:/data/qclick/deploy/docker-compose.yml"

    [[ -d "$CHAT_DIST_DIR" ]] || die "Missing $CHAT_DIST_DIR — run '$0 build' first (qclick-chat npm run build)"
    [[ -f "$CHAT_DIST_DIR/index.html" ]] || die "$CHAT_DIST_DIR/index.html missing — incomplete Vite build?"
    say "rsync qclick-chat dist ($CHAT_DIST_DIR/) → $VM:$REMOTE_CHAT_ROOT/"
    # Trailing slash on source: copy *contents* of dist into REMOTE_CHAT_ROOT (not dist/ as a subfolder).
    rsync_vm "$CHAT_DIST_DIR/" "$VM:$REMOTE_CHAT_ROOT/"

    say "scp qsql CLI + compare_parquet_oracle.py → $VM:/data/qclick/"
    scp_vm "$DEPLOY_DIR/qsql" "$AGENT_DIR/scripts/compare_parquet_oracle.py" \
        "$VM:/data/qclick/"
    ssh_vm "chmod +x /data/qclick/qsql"
}

cmd_install() {
    require_vm
    say "Warm SSH connection"
    ssh_vm true

    say "Open firewalld port $BACKEND_PORT/tcp (idempotent)"
    ssh_vm "
        if command -v firewall-cmd >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
            sudo firewall-cmd --permanent --add-port=${BACKEND_PORT}/tcp >/dev/null || true
            sudo firewall-cmd --reload >/dev/null || true
            sudo firewall-cmd --list-ports
        else
            echo 'skipping firewalld (no firewall-cmd or no passwordless sudo)'
        fi
    " || warn "Could not update firewalld — open port $BACKEND_PORT manually if /health is unreachable"

    say "Load image + recreate backend on $VM"
    ssh_vm "
        set -e
        docker load -i /data/qclick/qclick-agent-$VERSION.tar.gz
        [ -f /data/qclick/deploy/.env ] || cp /data/qclick/deploy/.env.template /data/qclick/deploy/.env
        sed -i 's|^VERSION=.*|VERSION=$VERSION|' /data/qclick/deploy/.env
        grep -q '^VERSION=' /data/qclick/deploy/.env || echo 'VERSION=$VERSION' >> /data/qclick/deploy/.env
        cd /data/qclick/deploy
        docker compose up -d --force-recreate lexia-backend
        docker compose ps
    "

    say "Wait for /health (up to 60s)…"
    if wait_healthy 60; then
        ssh_vm "cd /data/qclick/deploy && docker compose logs --tail=20 lexia-backend"
    else
        warn "/health never answered — dumping container logs for triage"
        ssh_vm "cd /data/qclick/deploy && docker compose ps && docker compose logs --tail=80 lexia-backend"
        die "backend did not become healthy within 60s"
    fi
}

cmd_verify() {
    require_vm
    local base="http://$VM_HOST:$BACKEND_PORT"
    local fail=0

    say "[1/4] /health (with up-to-60s wait)"
    if wait_healthy 60; then
        curl -sSf "$base/health" | python3 -m json.tool
    else
        warn "/health unreachable — likely firewalld is blocking ${BACKEND_PORT}/tcp. Try: $0 firewall"
        fail=1
    fi

    say "[2/4] /skills  (count should be > 0)"
    local skills_json count
    if skills_json=$(curl -sSf --max-time 5 "$base/skills" 2>/dev/null); then
        count=$(printf '%s' "$skills_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))' 2>/dev/null || echo 0)
        if [[ "$count" -gt 0 ]]; then
            printf "   skills loaded: %s\n" "$count"
        else
            warn "skills registry is empty"; fail=1
        fi
    else
        warn "skills endpoint unreachable"; fail=1
    fi

    say "[3/4] /qclick/  (frontend static via nginx)"
    curl -sSI --max-time 5 "http://$VM_HOST/qclick/" | head -3 || { warn "frontend check failed"; fail=1; }

    say "[4/4] Oracle thick mode (inside container)"
    # Reuse the multiplexed SSH session so this does NOT re-prompt for a password.
    if ssh_vm "docker exec -i qclick-agent python -" <<'PY'
import services.connectors.oracle_connector, oracledb
assert not oracledb.is_thin_mode(), "thick mode NOT active"
print("OK", oracledb.clientversion())
PY
    then :; else warn "Oracle thick-mode probe failed"; fail=1; fi

    if [[ "$fail" -eq 0 ]]; then
        printf "\n${c_grn}✓ All checks passed.${c_rst}\n"
    else
        printf "\n${c_red}✗ One or more checks failed.${c_rst}\n"
        exit 1
    fi
}

cmd_firewall() {
    require_vm
    say "Open firewalld port $BACKEND_PORT/tcp on $VM"
    ssh_vm "
        sudo firewall-cmd --permanent --add-port=${BACKEND_PORT}/tcp
        sudo firewall-cmd --reload
        sudo firewall-cmd --list-ports
    "
}

cmd_rollback() {
    require_vm
    say "Rolling $VM back to VERSION=$VERSION"
    ssh_vm "
        set -e
        docker image inspect qclick-agent:$VERSION >/dev/null \
            || { echo 'Image qclick-agent:$VERSION not found on VM'; exit 1; }
        sed -i 's|^VERSION=.*|VERSION=$VERSION|' /data/qclick/deploy/.env
        cd /data/qclick/deploy
        docker compose up -d --force-recreate lexia-backend
        docker compose ps
    "
}

cmd_logs() {
    require_vm
    ssh_vm "cd /data/qclick/deploy && docker compose logs -f --tail=100 lexia-backend"
}

cmd_compare() {
    require_vm
    local script="$AGENT_DIR/scripts/compare_parquet_oracle.py"
    [[ -f "$script" ]] || die "missing $script"

    say "Warm SSH"
    ssh_vm true

    say "scp script → $VM:/tmp/"
    scp_vm "$script" "$VM:/tmp/compare_parquet_oracle.py"

    say "docker cp → qclick-agent:/tmp/"
    ssh_vm "docker cp /tmp/compare_parquet_oracle.py qclick-agent:/tmp/compare_parquet_oracle.py"

    local quoted=""
    local a
    for a in "${EXTRA_ARGS[@]:-}"; do
        quoted+=" $(printf '%q' "$a")"
    done
    say "docker exec python /tmp/compare_parquet_oracle.py${quoted}"
    ssh_vm "docker exec -i qclick-agent python /tmp/compare_parquet_oracle.py${quoted}"
}

cmd_all() {
    cmd_build
    cmd_ship
    cmd_install
    cmd_verify
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$COMMAND" in
    build)    cmd_build    ;;
    ship)     cmd_ship     ;;
    install)  cmd_install  ;;
    verify)   cmd_verify   ;;
    all)      cmd_all      ;;
    firewall) cmd_firewall ;;
    compare)  cmd_compare  ;;
    rollback) cmd_rollback ;;
    logs)     cmd_logs     ;;
    help|"")  cmd_help     ;;
    *)        die "Unknown command: $COMMAND (try 'help')" ;;
esac
