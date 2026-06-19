import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';

@ApiTags('Admin')
@Controller('admin/auth')
export class LegalAuthController {
  constructor(private readonly configService: ConfigService) {}

  @Post('login')
  @ApiOperation({ summary: 'Connexion administrateur (identifiant + mot de passe)' })
  async adminLogin(
    @Body() body: { username?: string; password?: string },
  ): Promise<{ access_token: string; expires_in: number; email: string | null }> {
    const username = body.username?.trim();
    const password = body.password;
    if (!username || !password) {
      throw new BadRequestException('Identifiant et mot de passe requis');
    }

    const url = this.configService.get<string>('keycloak.url');
    const realm = this.configService.get<string>('keycloak.realm');
    const clientId = this.configService.get<string>('keycloak.clientId');
    const clientSecret = this.configService.get<string>('keycloak.clientSecret');

    let tokenResp: { access_token: string; expires_in: number };
    try {
      const response = await axios.post(
        `${url}/realms/${realm}/protocol/openid-connect/token`,
        new URLSearchParams({
          grant_type: 'password',
          client_id: clientId,
          client_secret: clientSecret,
          username,
          password,
          scope: 'openid email profile',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
        },
      );
      tokenResp = response.data;
    } catch {
      throw new UnauthorizedException('Identifiant ou mot de passe incorrect');
    }

    const decoded = jwt.decode(tokenResp.access_token) as jwt.JwtPayload | null;
    const roles: string[] = decoded?.realm_access?.roles || [];
    if (!roles.includes('admin') && !roles.includes('superadmin')) {
      throw new ForbiddenException('Ce compte n\'a pas les droits administrateur');
    }

    return {
      access_token: tokenResp.access_token,
      expires_in: tokenResp.expires_in,
      email: (decoded?.email as string) || (decoded?.preferred_username as string) || null,
    };
  }
}
