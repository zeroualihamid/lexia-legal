import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as jwksRsa from 'jwks-rsa';

export type AccessLevel = 'PUBLIC' | 'PRO' | 'ADMIN' | 'SUPERADMIN';

export interface AuthUser {
  userId: string;
  email: string;
  roles: string[];
  accessLevel: AccessLevel;
}

@Injectable()
export class KeycloakGuard implements CanActivate {
  private readonly logger = new Logger(KeycloakGuard.name);
  private jwksClient: jwksRsa.JwksClient;

  constructor(private configService: ConfigService) {
    const keycloakUrl = this.configService.get<string>('keycloak.url');
    const realm = this.configService.get<string>('keycloak.realm');

    this.jwksClient = jwksRsa({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      jwksUri: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    if (!token) {
      request.user = {
        userId: null,
        email: null,
        roles: [],
        accessLevel: 'PUBLIC' as AccessLevel,
      };
      return true;
    }

    try {
      const decoded = await this.verifyToken(token);
      const roles: string[] = decoded['realm_access']?.roles || [];
      const accessLevel = this.computeAccessLevel(roles);

      request.user = {
        userId: decoded['sub'],
        email: decoded['email'] || decoded['preferred_username'],
        roles,
        accessLevel,
      };
      return true;
    } catch (err) {
      this.logger.warn(`Token verification failed: ${err.message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: any): string | null {
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    if (request.query && request.query.token) {
      return request.query.token;
    }
    return null;
  }

  private verifyToken(token: string): Promise<jwt.JwtPayload> {
    return new Promise((resolve, reject) => {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || !decoded.header || !decoded.header.kid) {
        return reject(new Error('Invalid token structure'));
      }

      this.jwksClient.getSigningKey(decoded.header.kid, (err, key) => {
        if (err) return reject(err);
        const signingKey = key.getPublicKey();

        jwt.verify(token, signingKey, { algorithms: ['RS256'] }, (verifyErr, payload) => {
          if (verifyErr) return reject(verifyErr);
          resolve(payload as jwt.JwtPayload);
        });
      });
    });
  }

  private computeAccessLevel(roles: string[]): AccessLevel {
    if (roles.includes('superadmin')) return 'SUPERADMIN';
    if (roles.includes('admin')) return 'ADMIN';
    if (roles.includes('pro')) return 'PRO';
    return 'PUBLIC';
  }
}
