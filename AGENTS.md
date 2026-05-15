# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

**Lexia Legal** — a Moroccan legal AI platform (Arabic-first, RTL UI). Users ask legal questions in Arabic and get answers grounded in Moroccan laws, decrees, and court judgments via a RAG pipeline over Qdrant collections. The product is split into a public/PRO end-user app and an admin app for content + agent management.

## Repo layout

- `backend/` — NestJS 10 API (TypeScript). Entry: `src/main.ts` → `src/app.module.ts`. Domain modules live under `src/modules/`.
- `frontend/` — React 18 + Vite + Ant Design (RTL). Entry: `src/main.tsx` → `src/App.tsx`. Two apps mounted under one router: `src/apps/user/` and `src/apps/admin/`. Cross-app code in `src/shared/`.
- `infra/` — `postgres/init.sql` (full schema, ~570 lines, single source of truth — there is no migration tool), `keycloak/realm-export.json` (auto-imported on Keycloak boot), `nginx/nginx.conf` (reverse proxy + SSE passthrough).
- `docker-compose.yml` — orchestrates everything (nginx, frontend, backend, postgres ×2, keycloak, qdrant, minio, redis, bull-board).
- `.env.example` — copy to `.env` before first run; the backend reads it via `@nestjs/config` (`src/config/configuration.ts`).

## Commands

### Full stack (canonical)

```bash
cp .env.example .env             # then fill in secrets
docker compose up -d
docker compose logs -f backend   # or: frontend, keycloak, etc.
docker compose down              # add -v to wipe volumes (DESTROYS DATA)
```

URLs after boot: Frontend `http://localhost`, API `http://localhost/api`, Swagger `http://localhost/docs` (i.e. `api/docs` proxied), Keycloak admin `http://localhost:8080/admin`, MinIO console `http://localhost:9001`, Bull Board `http://localhost:3001`.

### Backend dev (outside Docker)

```bash
cd backend
npm install
npm run dev          # nest start --watch (port 4000)
npm run build        # nest build → dist/
npm run lint         # eslint src --ext .ts
```

There is **no test runner configured** in `backend/package.json` — do not invent `npm test` commands. If asked to add tests, propose the framework first.

The backend expects all infra services (postgres, redis, qdrant, minio, keycloak) to be reachable. The simplest local workflow is `docker compose up -d postgres redis qdrant minio keycloak postgres-keycloak` and then `npm run dev` against those.

### Frontend dev

```bash
cd frontend
npm install
npm run dev          # vite on :3000, proxies /api → localhost:4000
npm run build        # tsc && vite build
npm run preview
```

No lint or test scripts exist on the frontend.

### DB / cache shells

```bash
docker compose exec postgres psql -U legal_ai -d legal_ai
docker compose exec redis redis-cli -a ${REDIS_PASSWORD}
docker compose exec postgres pg_dump -U legal_ai legal_ai > backup_$(date +%Y%m%d).sql
```

## Architecture — what spans multiple files

### Auth & access levels (read this before touching any controller)

Authentication is **Keycloak OIDC**, verified per request by `KeycloakGuard` (`backend/src/common/guards/keycloak.guard.ts`) which fetches JWKS from Keycloak and decodes the bearer token (or `?token=` query param, used for SSE). It assigns `request.user: AuthUser` with one of four `accessLevel` values derived from realm roles:

`PUBLIC` (no token / no role) < `PRO` < `ADMIN` < `SUPERADMIN`

Authorization uses a **second** guard, `AccessLevelGuard`, gated by the `@RequireAccessLevel('PRO' | …)` decorator. Standard pattern on a controller:

```ts
@UseGuards(KeycloakGuard, AccessLevelGuard)
@Controller('chat')
class ChatController {
  @Post('conversations')
  @RequireAccessLevel('PRO')
  ...
}
```

`KeycloakGuard` always allows the request through (assigns `PUBLIC` if no token); `AccessLevelGuard` is what actually rejects. Don't add ad-hoc role checks — extend the decorator/guard pair.

The same `accessLevel` propagates into the RAG layer to filter Qdrant payloads (see `RagService.buildAccessFilter`): PUBLIC sees only `visibility='public'`; PRO additionally sees `pro_only` and own `owner_id`; ADMIN/SUPERADMIN sees everything. Keep that filter in sync if you add new visibility tiers.

### RAG / chat pipeline

`POST /api/chat/stream/:conversationId?q=…` is an **SSE** endpoint. The orchestration in `AgentService.streamChat` (`backend/src/modules/chat/agent/agent.service.ts`) is the chain:

1. Load active agent config (system prompt + skills) from Postgres via admin-managed tables.
2. Load conversation history (PRO+ only — PUBLIC has no persistence).
3. `RagService.routeCollections` — GPT-4o classifies the question into one or more of ~10 Qdrant collections (`legal_laws`, `judgments_*`, `user_documents`).
4. `RagService.search` — embed the question (`EmbeddingService`, OpenAI `text-embedding-3`), parallel-search each collection in Qdrant with the access-level filter, dedupe by id, top-10, then enrich with `documents` table metadata from Postgres.
5. Build Arabic system prompt (skills are concatenated `prompt_content` from admin config) + RAG context.
6. Stream completion from OpenAI, with tool-calling support via `ToolExecutorService`.

If you change the collection list, update **all four** of: `infra/postgres/init.sql` (`collection_type` enum), `RagService.ALL_COLLECTIONS`, the routing prompt in `RagService.routeCollections`, and frontend constants/labels.

SSE has special infra concerns: nginx must not buffer (set `X-Accel-Buffering: no`), and a 15s heartbeat is sent to keep the connection alive. Don't add response compression to this route.

### Async jobs (BullMQ)

Three Bull queues are wired in `main.ts` and exposed through Bull Board: `document-processing`, `scraping`, `embedding`. Processors live in `backend/src/modules/queue/`. Anything that touches OCR, web scraping, or vector indexing should be enqueued — never run inline in a request handler.

### Scrapers

Strategy pattern under `backend/src/modules/scraper/`: `base.scraper.ts` defines the contract, `adala.scraper.ts` and `sgg.scraper.ts` are concrete implementations, `scraper-factory.service.ts` selects one. New legal sources = new scraper class + register in the factory; the admin scraper controller (`modules/admin/scraper/`) is what triggers runs.

### Database

PostgreSQL 16 schema is defined entirely in `infra/postgres/init.sql` and applied **only at first boot** via `docker-entrypoint-initdb.d`. There is **no migration framework**. To change schema in dev: `docker compose down -v` and start fresh, OR write the ALTER manually and apply via `psql`. Coordinate with the user before introducing a migration tool.

The backend uses raw SQL through `PostgresService.query()` (a thin `pg` wrapper) — no ORM. Queries are parameterized with `$1, $2, …`.

Two separate Postgres instances run: `postgres` (app data) and `postgres-keycloak` (Keycloak's own DB). Don't confuse them.

### Frontend structure

- `App.tsx` is the single router. It initializes Keycloak (`check-sso` + PKCE) before rendering routes, derives `accessLevel` from realm roles into `useAuthStore` (Zustand), and mounts `<UserLayout>` for `/`, `/search`, `/billing` and `<AdminLayout>` for `/admin/*`.
- API access goes through `frontend/src/shared/api/client.ts` (axios). The interceptor injects the Keycloak token from `useAuthStore`, and on 401 it calls `keycloak.login()`. Don't bypass this client.
- UI is **Ant Design with `direction="rtl"`** and a custom theme driven by CSS variables in `index.css` (light/dark via `data-theme` attribute on `<html>`, controlled by `useThemeStore`). Use Ant components and the `var(--color-*)` tokens rather than hard-coded colors.
- All user-visible strings are Arabic. i18n exists at `src/i18n/` but the catalog is `ar.json` only — adding a language requires both a new JSON and an `i18next` resource entry.

### Admin module

`backend/src/modules/admin/` is a dense area: `agent-config/`, `skills/`, `tools/`, `mcp/`, `users/`, `scraper/`, `analytics/`. The agent's behavior at runtime (system prompt, available tools, enabled skills, MCP servers) is **data-driven from these tables**, not hardcoded. When the user mentions "the agent" they often mean a row in `agent_configs`, not the code in `chat/agent/`.

## Conventions

- Backend `tsconfig.json` is loose (`strictNullChecks: false`, `noImplicitAny: false`). Don't tighten it without discussing — existing code relies on it.
- Controllers always carry `@ApiTags` + `@ApiBearerAuth` + `@ApiOperation` for Swagger. Match the existing tag set in `main.ts`.
- Logging uses `Logger` from `@nestjs/common` with `private readonly logger = new Logger(ClassName.name)`. Keep that pattern.
- Sensitive values come from `ConfigService` (typed under `src/config/configuration.ts`) — never read `process.env` directly inside services.
- Arabic strings in code (system prompts, labels) are intentional and load-bearing for the legal domain. Don't translate them to English.
