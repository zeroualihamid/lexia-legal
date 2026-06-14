import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { authRequired, getSessionFromRequest } from "../common/session";
import { isProxiedPath } from "./proxy.constants";

/**
 * Express-level reverse proxy to the qclick-agent FastAPI service.
 *
 * It is mounted at the root of the underlying Express instance (before the
 * NestJS router) and:
 *   - lets non-agent requests fall through to NestJS (auth, chat/stream,
 *     health, /api/me, /docs);
 *   - enforces a better-auth session on agent requests (unless
 *     PROXY_REQUIRE_AUTH=false);
 *   - streams the raw request/response (no body parsing — works because the
 *     app is created with bodyParser:false), preserving SSE byte framing and
 *     headers such as X-Session-ID / X-API-Key.
 *
 * Note: the generic proxy runs as middleware, so it cannot use a NestJS guard;
 * the session check is performed inline here. The dedicated /chat/stream route
 * is handled by ChatController (guarded by AuthGuard) instead.
 */
export function createAgentProxy(): RequestHandler {
  const target = process.env.LEXIA_AGENT_URL ?? "http://localhost:8000";

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: false,
    xfwd: true,
    // Never time out: chat/report SSE streams are long-lived; the agent sends
    // heartbeats to keep them alive.
    proxyTimeout: 0,
    timeout: 0,
    on: {
      proxyRes: (proxyRes) => {
        // Defeat any intermediary buffering for (possibly streaming) responses.
        proxyRes.headers["x-accel-buffering"] = "no";
      },
      error: (err, _req, res) => {
        const r = res as Response;
        if (typeof r.writeHead === "function" && !r.headersSent) {
          r.writeHead(502, { "content-type": "application/json" });
        }
        try {
          r.end(JSON.stringify({ status: "bad_gateway", error: String(err) }));
        } catch {
          /* socket already gone */
        }
      },
    },
  });

  return function agentProxyGate(req: Request, res: Response, next: NextFunction): void {
    if (req.method === "OPTIONS" || !isProxiedPath(req.path)) {
      next();
      return;
    }
    if (!authRequired()) {
      proxy(req, res, next);
      return;
    }
    getSessionFromRequest(req)
      .then((session) => {
        if (!session) {
          res.status(401).json({ error: "unauthorized" });
          return;
        }
        (req as Request & { session?: unknown }).session = session;
        proxy(req, res, next);
      })
      .catch((err) => {
        res.status(500).json({ error: "auth_check_failed", detail: String(err) });
      });
  };
}
