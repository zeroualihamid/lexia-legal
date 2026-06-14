# Brikz Admin / Backend Integration

`brikz-backend` is the only API surface used by `brikz-admin`. It serves
better-auth and Cross Tower routes itself, and reverse-proxies agent routes to
`LEXIA_AGENT_URL`.

## Development Topology

| Service | URL |
| --- | --- |
| `brikz-admin` | `http://localhost:5175` |
| `brikz-backend` | `http://localhost:3020` |
| `brikz-agent` | Internal backend upstream, normally `http://localhost:8000` |

Keep `VITE_API_URL` empty for local development. Requests remain same-origin
from the browser and Vite forwards them to `VITE_BACKEND_URL`.

Required backend environment:

```env
PORT=3020
BETTER_AUTH_URL=http://localhost:3020
LEXIA_ADMIN_ORIGIN=http://localhost:5175
LEXIA_AGENT_URL=http://localhost:8000
```

## Production Topology

The `brikz-admin` nginx container and `brikz-backend` share the
`brikz-internal` Compose network:

```text
browser -> brikz-admin:80 -> brikz-backend:3000 -> brikz-agent:8000
```

The admin bundle uses relative URLs. nginx preserves the complete request path
and disables buffering for SSE/report streams.

## Authentication

Authentication uses the better-auth endpoints under `/api/auth/*`. Session
cookies are sent with all same-origin backend requests. For direct
cross-origin mode, set `VITE_API_URL` and configure the exact frontend origin
in `LEXIA_ADMIN_ORIGIN`.

The seeded internal operator account is:

```text
username: admin
email: admin@qclick.local
password: admin
```

The seed script and better-auth migrations require a reachable PostgreSQL
database.

## Route Contract

Backend-owned routes include:

```text
/api
/chat
/conversation
/domains
/cards
/parquet
/cte-graph
/workflow
/graph
/agents
/data
/skills
/reporting
/playground
/stream
/admin
/health
/docs
/docs-json
```

Run the alignment check after changing backend route prefixes:

```bash
npm run check:backend-contract
```

## Smoke Checks

```bash
curl http://localhost:3020/health
curl -i http://localhost:3020/api/me
curl -i http://localhost:5175/api/me
```

Without a session, `/api/me` should return `401`. A response through port
`5175` confirms the admin proxy reaches `brikz-backend`.
