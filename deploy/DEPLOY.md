# Brikz Cross — Build & Deploy

Build on Mac, ship to a Linux VM. **brikz-agent** and **brikz-backend** are built from this repo (`brikz-agent/Dockerfile` and `brikz-backend/Dockerfile`). For a Cython release image, build with `brikz-agent/Dockerfile.release` instead.

## Prereqs

- **Mac**: Docker Desktop, Node 20+, `rsync`.
- **VM**: Docker ≥ 24 + Compose v2, nginx, `/data/brikz/` writable, TCP access to Oracle.
- **Agent image**: built as `brikz-agent:$VERSION` from `../brikz-agent` (compose default).

## Export release vars

```bash
export VERSION=2026.04.21
export VM_HOST=172.16.20.40
export VM="uadmin@$VM_HOST"
export BACKEND_PORT=6002
export LEXIA_ADMIN_PORT=5175
export VITE_API_URL="http://$VM_HOST:$BACKEND_PORT"
export VITE_BASE="/brikz/"
```

## Build

```bash
# brikz-backend (better-auth + reverse proxy to brikz-agent)
docker buildx build --platform linux/amd64 \
  -f brikz-backend/Dockerfile \
  -t brikz-backend:$VERSION \
  --load .
mkdir -p release/dist
docker save brikz-backend:$VERSION | gzip > release/dist/brikz-backend-$VERSION.tar.gz

# brikz-agent (included in compose build; optional manual image export):
#   docker buildx build -f brikz-agent/Dockerfile -t brikz-agent:$VERSION …

# Frontend → static dist/
cd brikz-chat
printf 'VITE_API_URL=%s\nVITE_BASE=%s\n' \
  "$VITE_API_URL" "$VITE_BASE" > .env.production
npm ci && npm run build
```

## lexia-legal stack (docker compose)

Canonical file: **`deploy/docker-compose.yml`** (stack name `lexia-legal`).

From repo root:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

From `deploy/`:

```bash
docker compose up -d
```

Multi-service stack:

| Service | Image / build | Role |
|---------|---------------|------|
| `lexia-backend` | `lexia-backend/Dockerfile` | Unified API: legal platform + better-auth + agent proxy |
| `frontend` | `../frontend/Dockerfile` | Legal platform React UI (via nginx :80) |
| `lexia-admin` | `lexia-admin:$VERSION` | Internal admin UI; nginx proxy to `lexia-backend` |
| `lexia-agent` | `lexia-agent:$VERSION` | FastAPI agent on internal `:8000` |
| `minio` | `minio/minio` | Object storage (`minio:9000` inside the network) |
| `redis` | `redis:7-alpine` | BullMQ + cache |
| `qdrant` | `qdrant/qdrant` | Vector DB (internal `qdrant:6333`) |
| `postgres` | `postgres:16-alpine` | Application DB (`legal_ai` + optional `lexia_auth`) |
| `keycloak` | Keycloak 24 | IAM for legal platform |
| `pgadmin` | `dpage/pgadmin4` | Optional DB admin UI |

`lexia-backend` publishes port `LEXIA_BACKEND_PORT` (default `6002`); `lexia-admin` publishes `LEXIA_ADMIN_PORT` (default `5175`).
The browser never talks to `lexia-agent` directly.

### First-time setup

1. Copy `.env.template` → `.env` and fill **at minimum**:
   - `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` (also become the S3 access/secret for brikz-agent)
   - `POSTGRES_PASSWORD`
   - `PGADMIN_DEFAULT_EMAIL`, `PGADMIN_DEFAULT_PASSWORD`
   - `BETTER_AUTH_SECRET` (`openssl rand -hex 32`)
   - `BETTER_AUTH_URL` (e.g. `http://$VM_HOST:$BACKEND_PORT`)
   - `LEXIA_CHAT_ORIGIN` (brikz-frontend URL, e.g. `http://localhost:5173`)
   - `LEXIA_ADMIN_ORIGIN` (brikz-admin URL, e.g. `http://$VM_HOST:$LEXIA_ADMIN_PORT`)
   - `RESEND_API_KEY`, `RESEND_FROM` (verified Resend sender, e.g. `auth@yourdomain.com`)
2. Open firewall port `$BACKEND_PORT` if the host firewall is active.
3. Optional nginx reverse proxy: terminate TLS and proxy `/api/auth/` → `http://127.0.0.1:$BACKEND_PORT`.

### Smoke tests

```bash
# Backend liveness
curl -fsS http://$VM_HOST:$BACKEND_PORT/health

# Admin nginx -> backend (401 without a session is expected)
curl -i http://$VM_HOST:$LEXIA_ADMIN_PORT/api/me

# Signup → expect a Resend email with a verification link
curl -X POST http://$VM_HOST:$BACKEND_PORT/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"hunter22hunter22","name":"You"}'
```

Quick build check:

```bash
# Oracle thick-mode active inside qclick-agent image (fixes DPY-3015)
docker run --rm --platform linux/amd64 qclick-agent:$VERSION python -c \
  "import services.connectors.oracle_connector, oracledb; print(oracledb.is_thin_mode(), oracledb.clientversion())"
# → False (23, 26, 1, 0, 0)

# Frontend uses the right base path
grep -Eo '/brikz/[^"]*' brikz-chat/dist/assets/*.js | head -3
```

## Ship

```bash
# Images
scp release/dist/brikz-backend-$VERSION.tar.gz $VM:/data/brikz/
scp /path/from/qclick/qclick-agent-$VERSION.tar.gz $VM:/data/brikz/

# Config + compose (only if changed)
scp deploy/config/*.yaml          $VM:/data/brikz/deploy/config/
scp deploy/docker-compose.yml     $VM:/data/lexia-legal/deploy/docker-compose.yml

# Frontend static bundle
rsync -av --delete brikz-chat/dist/ $VM:/data/brikz/chat/
```

## Install / upgrade on VM

```bash
ssh $VM "
  docker load -i /data/brikz/brikz-backend-$VERSION.tar.gz &&
  docker load -i /data/brikz/qclick-agent-$VERSION.tar.gz &&
  sed -i 's/^VERSION=.*/VERSION=$VERSION/' /data/brikz/deploy/.env &&
  cd /data/brikz/deploy &&
  docker compose up -d --force-recreate &&
  docker compose ps
"
```

## First-time-only extras

1. Copy `.env.template` → `/data/brikz/deploy/.env`, fill in LLM / `ORACLE_*` creds.
2. Add nginx block and reload (`nginx -t && systemctl reload nginx`):
   ```nginx
   location = /brikz { return 301 /brikz/; }
   location /brikz/  {
       alias /data/brikz/chat/;
       try_files $uri $uri/ /brikz/index.html;
       types {
         text/javascript js mjs; text/css css; application/json json;
         image/png png; image/jpeg jpg jpeg; image/svg+xml svg;
         image/webp webp; video/webm webm; font/woff2 woff2;
       }
   }
   ```
3. `firewall-cmd --permanent --add-port=$BACKEND_PORT/tcp && firewall-cmd --reload` (if active).
4. If a stale empty `app_prompts` volume exists, remove it so the qclick-agent image seeds it:
   `docker volume ls -q | grep -E '(^|_)app_prompts$' | xargs -r docker volume rm`

## Runtime `app_data` volume (reporting + CTE profiles)

Compose mounts `app_data` → `/app/data`, which **masks** packaged `/app/data` from the qclick-agent image.

The qclick-agent image runs **`docker-entrypoint.sh`** before `uvicorn`:

- Seeds **`data/reporting/`** from `/opt/qclick-seed/` into `/app/data/reporting/` on **every** start (new catalog SQL/`index.yaml` from the image is merged in).
- Copies **`data/cte_graph_profiles.json`** only when that file is **missing** on the volume (VM edits are kept).

After upgrading the agent image, load the new `qclick-agent` tarball and recreate `brikz-agent` so `GET /cte-graph/profiles` matches the running API build.

## Verify

```bash
curl -sS  http://$VM_HOST:$BACKEND_PORT/health   | python3 -m json.tool
curl -sS  http://$VM_HOST:$BACKEND_PORT/skills   | python3 -m json.tool   # count > 0
curl -sS  http://$VM_HOST:$BACKEND_PORT/cte-graph/profiles | python3 -m json.tool  # 200, profiles list
curl -sSI http://$VM_HOST/brikz/                | head -3                # 200 OK
ssh $VM 'docker exec -i brikz-cross-agent python -c "
import services.connectors.oracle_connector, oracledb
assert not oracledb.is_thin_mode()
print(\"OK\", oracledb.clientversion())"'
```

## Edit skills / prompts at runtime (encrypted on disk)

```bash
# List / read / edit a skill
curl -sS      http://$VM_HOST:$BACKEND_PORT/skills
curl -sS      http://$VM_HOST:$BACKEND_PORT/skills/<dir>
curl -sS -XPUT http://$VM_HOST:$BACKEND_PORT/skills/<dir> \
  -H 'Content-Type: application/json' -d '{"description":"new"}'

# Prompt templates
curl -sS      http://$VM_HOST:$BACKEND_PORT/skills/templates/list
curl -sS -XPUT http://$VM_HOST:$BACKEND_PORT/skills/templates/<cat>/<name> \
  -H 'Content-Type: application/json' -d '{"content":"edited"}'
```

Edits persist across restarts (`app_prompts` named volume) and stay encrypted (`*.md.enc`).

## Rollback

```bash
ssh $VM "sed -i 's/^VERSION=.*/VERSION=<previous>/' /data/brikz/deploy/.env &&
         cd /data/brikz/deploy && docker compose up -d --force-recreate"
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `DPY-3015 password verifier 0x939` | qclick-agent image must have `/opt/oracle/instantclient` (`VERSION≥2026.04.19`) |
| `Connexion refusée` / TCP timeout to Oracle | Network ACL — ask DBA to allow the VM IP |
| `ORA-00942 Table … inexistante` | Qualify `table_name: <schema>.<name>` in `datasources.yaml` |
| `/skills` returns `count:0` | `VERSION≥2026.04.18`; if using `app_prompts` volume, remove the empty one and recreate |
| `/parquet/columns/schema` → 500 `not in subpath of /app/data` | `VERSION≥2026.04.20` |
| Frontend JS MIME-type error | Rebuild with `VITE_BASE=/brikz/`, verify nginx `types` block |
| `pull access denied for qclick-agent` | `docker load -i qclick-agent-…tar.gz` on the VM |
| `pull access denied for brikz-backend` | `docker load -i brikz-backend-…tar.gz` on the VM |
| `no space left on device` | `sudo journalctl --vacuum-size=200M && docker system prune -af`; relocate docker data-root to `/data/docker` for a permanent fix |

Logs:

```bash
ssh $VM 'cd /data/brikz/deploy && docker compose logs --tail=200 brikz-backend brikz-agent'
```

Shell into agent container (everything Python is `.so`; only `/app/data/classes/dtos/` is plaintext):

```bash
ssh $VM 'docker exec -it brikz-cross-agent bash'
```

## Deploying to a second VM

No rebuild. Re-export `VM_HOST`, then repeat **Ship** + **Install**. Frontend rebuild only needed if `VITE_API_URL` differs.

## File map

| Path | Role |
| --- | --- |
| `brikz-backend/Dockerfile` | better-auth + reverse proxy image |
| `brikz-admin/Dockerfile.release` | admin UI + same-origin backend proxy image |
| `brikz-admin/nginx.conf` | production route and SSE proxy contract |
| `deploy/docker-compose.yml` | Compose stack `lexia-legal` + named volumes (`app_data`, `app_prompts`) |
| `deploy/config/*.yaml` | Runtime-editable config (bind-mounted RO) |
| `deploy/.env` | Credentials + `VERSION` |
| `brikz-chat/src/lib/asset.ts` | Base-path-aware static asset URLs |
| `brikz-chat/.env.production` | Build-time `VITE_API_URL` + `VITE_BASE` |
| *(Qclick repo)* `qclick-agent` image | Shared agent runtime consumed as `qclick-agent:$VERSION` |
