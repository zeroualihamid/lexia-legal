import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Allows any authenticated user through (i.e. a valid Keycloak token was
 * presented and `request.user.userId` is set). Use after `KeycloakGuard`,
 * which assigns `accessLevel = PUBLIC` and `userId = null` for anonymous
 * requests. This is the gate for features open to every logged-in lawyer
 * regardless of their PRO/ADMIN role (basic users are PUBLIC).
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!request.user || !request.user.userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return true;
  }
}
