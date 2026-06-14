import type { IncomingMessage } from "http";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../auth";

export type AppSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * Resolve a better-auth session from a raw Node request (works for both
 * NestJS controller requests and Express-level middleware, since both expose
 * `.headers`). Returns null when there is no valid session.
 */
export async function getSessionFromRequest(req: IncomingMessage): Promise<AppSession> {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
}

/**
 * Whether chat/agent routes must carry a valid better-auth session.
 * Enforced by default; set PROXY_REQUIRE_AUTH=false to open the proxy
 * (e.g. for local debugging) without code changes.
 */
export function authRequired(): boolean {
  return process.env.PROXY_REQUIRE_AUTH !== "false";
}
