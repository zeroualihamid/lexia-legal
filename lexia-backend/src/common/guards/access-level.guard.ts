import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessLevel } from './keycloak.guard';

const ACCESS_LEVEL_ORDER: Record<AccessLevel, number> = {
  PUBLIC: 0,
  PRO: 1,
  ADMIN: 2,
  SUPERADMIN: 3,
};

export const REQUIRED_ACCESS_LEVEL_KEY = 'requiredAccessLevel';

@Injectable()
export class AccessLevelGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredLevel = this.reflector.getAllAndOverride<AccessLevel>(
      REQUIRED_ACCESS_LEVEL_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredLevel) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const userLevel = ACCESS_LEVEL_ORDER[user.accessLevel as AccessLevel] ?? 0;
    const required = ACCESS_LEVEL_ORDER[requiredLevel] ?? 0;

    if (userLevel < required) {
      throw new ForbiddenException(
        `Access level ${requiredLevel} or higher required`,
      );
    }

    return true;
  }
}
