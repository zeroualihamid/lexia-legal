# Qclick — On-Premises Deployment

> **Operators building or shipping a release**: see
> [`DEPLOY.md`](./DEPLOY.md) for the full build→ship→verify runbook (includes
> Oracle thick-mode setup, named volumes for editable prompts, nginx config,
> VM hardening checks, and a troubleshooting matrix). This README is the
> one-page overview for clients receiving a finished bundle.

This bundle delivers the **Qclick Agent** (backend API) + **Qclick Chat** (frontend) as
pre-built Docker images with all Python source compiled to native `.so` binaries
(Cython) and all LLM prompt templates encrypted with Fernet.

What the client can edit:

- `config/*.yaml` — LLM routing, data sources, cache windows
- `.env` — API keys, database credentials
- `deploy/docker-compose.yml` — unified stack (legal platform + agent); run from repo root with `-f deploy/docker-compose.yml` or from `deploy/` with `docker compose up -d`

What is protected (not readable):

- All Python business logic → compiled `.so`
- All `prompts/**/*.md` templates → encrypted `.md.enc` (key baked into the compiled
  `prompt_loader.so`)
- OpenAPI schema (`/docs`, `/redoc`, `/openapi.json`) disabled when
  `LEXIA_ENV=production`

---

## Contents of this bundle

```
qclick-deploy/
  docker-compose.yml          # Backend + frontend orchestration
  .env.template               # Copy → .env and fill in
  README.md                   # This file
  config/
    config.yaml               # LLM routing + app settings
    llm_config.yaml           # Providers + models
    datasources.yaml          # Oracle / SQL Server / Parquet data sources
  images/
    qclick-agent-<ver>.tar.gz # Pre-built backend image (compiled)
    qclick-chat-<ver>.tar.gz  # Pre-built frontend image (minified)
```

---

## Prerequisites on the VM

- Linux x86_64
- Docker ≥ 24.0 + Docker Compose v2 plugin
- Ports 80 (frontend) and 8000 (backend) available (or override in `.env`)
- Outbound HTTPS to LLM providers (OpenAI / OpenRouter / Groq / etc.)

Optional:

- Oracle Instant Client already installed on the DB server (not on this VM) if you
  intend to use Oracle connectors. The image ships `unixodbc` runtime libs.

---

## First-time install

```bash
# 1. Copy the deploy bundle to the VM (from your laptop)
scp -r qclick-deploy uadmin@DocAnalyticAPI:/data/qclick/

# 2. SSH into the VM
ssh uadmin@DocAnalyticAPI

# 3. Move into the deploy dir
cd /data/qclick/qclick-deploy

# 4. Load the two Docker images
docker load -i images/qclick-agent-<version>.tar.gz
docker load -i images/qclick-chat-<version>.tar.gz

# 5. Verify images are present
docker images | grep qclick

# 6. Create your .env from the template and fill in keys + DB creds
cp .env.template .env
vi .env            # fill in OPENAI_API_KEY, ORACLE_*, etc.

# 7. (optional) adjust config/*.yaml
vi config/config.yaml

# 8. Start the stack (from deploy/)
docker compose up -d

# From repo root instead:
# docker compose -f deploy/docker-compose.yml up -d

# 9. Tail the logs
docker compose logs -f lexia-backend
```

The frontend is now available on `http://<vm-host>:80` (or the port set via
`FRONTEND_PORT` in `.env`); the backend API on `http://<vm-host>:8000`.

---

## Updating to a new version

1. `scp` the new `images/qclick-agent-<new>.tar.gz` and `qclick-chat-<new>.tar.gz`
2. `docker load -i qclick-agent-<new>.tar.gz` (and the chat one)
3. Edit `.env` → set `VERSION=<new>`
4. `docker compose up -d` — Compose pulls the new image tag and restarts

No config or data is lost: `./config/` is mounted read-only, `app_data` is a named
Docker volume.

---

## Operational commands

| Task                               | Command                                             |
| ---------------------------------- | --------------------------------------------------- |
| Start                              | `docker compose up -d` (from `deploy/`)             |
| Stop                               | `docker compose down`                               |
| Restart agent API                  | `docker compose restart lexia-backend`              |
| View live logs                     | `docker compose logs -f lexia-backend`              |
| Shell inside agent API             | `docker compose exec lexia-backend sh`              |
| Persisted data volume path         | `docker volume inspect qclick-deploy_app_data`      |
| Reload YAML configs (no downtime)  | `docker compose restart backend` (configs are RO-mounted) |

---

## Troubleshooting

### `backend` container exits immediately

Run `docker compose logs backend` and look for the last lines:

- **`ImportError: ... cpython-312-x86_64-linux-gnu.so`** — the image was built for
  the wrong architecture. Verify `uname -m` on the VM shows `x86_64`.
- **`cryptography.fernet.InvalidToken`** — prompt decryption failed. The image was
  built without a valid build key, or `.md.enc` files are corrupted.
- **`Connection refused ... :1521`** — Oracle not reachable from the VM; check
  `ORACLE_HOST` in `.env` and network ACLs.

### Frontend loads but API calls fail

Check the nginx proxy in the frontend container — it routes `/api/` and `/chat/`
to `http://backend:8000`. Both services must be on the same Compose network (they
are by default).

### Clearing runtime state

Stop the stack, remove the named volume, restart:

```bash
docker compose down
docker volume rm qclick-deploy_app_data
docker compose up -d
```

---

## Security notes

- The prompt encryption key is **baked into the `prompt_loader.so` binary**; it is
  not recoverable without binary reverse-engineering (IDA Pro / Ghidra class of
  effort).
- `LEXIA_ENV=production` disables OpenAPI docs so the client cannot inspect the
  full API schema.
- `.env` stores raw credentials — keep its permissions at `600` and never commit.
- The `config/` directory is mounted **read-only** inside the container.
