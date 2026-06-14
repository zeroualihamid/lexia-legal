import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { authRequired, getSessionFromRequest } from "../common/session";

/**
 * Guards in-process NestJS routes (e.g. POST /chat/stream) behind a valid
 * better-auth session. The proxied agent routes are guarded separately at the
 * Express middleware level (see proxy/agent-proxy.ts) because the generic
 * reverse proxy runs as middleware, before Nest guards.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const session = await getSessionFromRequest(req);
    req.session = session;
    if (!authRequired()) return true;
    if (!session) throw new UnauthorizedException();
    return true;
  }
}
