import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AppSession } from "../common/session";

/**
 * Injects the better-auth session attached to the request by AuthGuard.
 * Usage: `@Session() session: AppSession`
 */
export const Session = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AppSession =>
    ctx.switchToHttp().getRequest().session ?? null,
);
