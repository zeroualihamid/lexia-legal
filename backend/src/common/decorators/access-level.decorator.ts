import { SetMetadata } from '@nestjs/common';
import { AccessLevel } from '../guards/keycloak.guard';
import { REQUIRED_ACCESS_LEVEL_KEY } from '../guards/access-level.guard';

export const RequireAccessLevel = (level: AccessLevel) =>
  SetMetadata(REQUIRED_ACCESS_LEVEL_KEY, level);

export { AccessLevel };
