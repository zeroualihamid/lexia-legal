# Brikz Admin

Internal React/Vite administration UI for the Cross Tower stack.

All browser traffic goes through `brikz-backend`:

- `/api/auth/*` and `/api/me`: better-auth
- `/chat/stream`: NestJS SSE bridge
- `/api/*`: Cross Tower REST API and proxied agent `/api/v1/*`
- `/skills`, `/parquet`, `/reporting`, `/cte-graph`, and other agent routes:
  reverse-proxied by `brikz-backend`

The browser must never call `brikz-agent` directly.

## Local Development

Start `brikz-backend` on port `3020`, then:

```bash
cd brikz-admin
npm install
npm run dev
```

Open `http://localhost:5175`. The Vite server proxies backend-owned paths to
`VITE_BACKEND_URL` (`http://localhost:3020` by default), keeping auth cookies
first-party.

Configuration:

```env
VITE_BACKEND_URL=http://localhost:3020
VITE_API_URL=
VITE_ANALYST_URL=
```

Set `VITE_API_URL` only for a deliberate direct cross-origin deployment. The
backend origin must then allow the admin origin through `LEXIA_ADMIN_ORIGIN`.

## Compose

From repo root (or `deploy/`):

```bash
docker compose -f deploy/docker-compose.yml up -d lexia-admin
```

The admin UI is published on `LEXIA_ADMIN_PORT` (default `5175`). Its nginx
container proxies all API and SSE paths to `lexia-backend:3000`.

## Verification

```bash
npm run check:backend-contract
npm run build
```

The contract check fails when backend-owned top-level routes are missing from
the Vite or nginx proxy configuration.
