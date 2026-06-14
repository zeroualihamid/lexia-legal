import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private configService: ConfigService) {}

  private async getAdminToken(): Promise<string> {
    const url = this.configService.get<string>('keycloak.url');
    const password = this.configService.get<string>('keycloak.adminPassword');

    const response = await axios.post(
      `${url}/realms/master/protocol/openid-connect/token`,
      new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'admin',
        password,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      },
    );
    return response.data.access_token;
  }

  private get adminBase(): { url: string; realm: string } {
    return {
      url: this.configService.get<string>('keycloak.url'),
      realm: this.configService.get<string>('keycloak.realm'),
    };
  }

  private normalizeRole(role?: string): string {
    return (role || 'user').toLowerCase();
  }

  private toApiUser(user: any, realmRoles: any[] = []): any {
    const roleNames = realmRoles.map((r) => r.name);
    const role = roleNames.includes('superadmin')
      ? 'SUPERADMIN'
      : roleNames.includes('admin')
        ? 'ADMIN'
        : roleNames.includes('pro')
          ? 'PRO'
          : 'PUBLIC';

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.firstName || user.email || user.username,
      role,
      realmRoles: roleNames,
      is_active: user.enabled,
      created_at: user.createdTimestamp ? new Date(user.createdTimestamp).toISOString() : null,
      last_login: null,
      subscription: role === 'PRO' ? 'pro' : role === 'ADMIN' || role === 'SUPERADMIN' ? 'enterprise' : null,
      messages_today: 0,
    };
  }

  async listUsers(params: {
    first?: number;
    max?: number;
    search?: string;
  } = {}): Promise<any[]> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;

    const query = new URLSearchParams({
      first: String(params.first || 0),
      max: String(params.max || 50),
      ...(params.search ? { search: params.search } : {}),
    });

    const response = await axios.get(
      `${url}/admin/realms/${realm}/users?${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const users = response.data;
    const withRoles = await Promise.all(
      users.map(async (user: any) => {
        try {
          const rolesResp = await axios.get(
            `${url}/admin/realms/${realm}/users/${user.id}/role-mappings/realm`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          return this.toApiUser(user, rolesResp.data);
        } catch {
          return this.toApiUser(user);
        }
      }),
    );
    return withRoles;
  }

  async getUser(userId: string): Promise<any> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;

    const [userResp, rolesResp] = await Promise.all([
      axios.get(`${url}/admin/realms/${realm}/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      axios.get(
        `${url}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    ]);

    return this.toApiUser(userResp.data, rolesResp.data);
  }

  async createUser(body: {
    username?: string;
    email: string;
    name?: string;
    password: string;
    role?: string;
    enabled?: boolean;
  }): Promise<any> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;
    const [firstName, ...lastParts] = (body.name || '').trim().split(/\s+/).filter(Boolean);
    const username = body.username || body.email;

    const createResp = await axios.post(
      `${url}/admin/realms/${realm}/users`,
      {
        username,
        email: body.email,
        firstName: firstName || body.name || username,
        lastName: lastParts.join(' '),
        enabled: body.enabled ?? true,
        emailVerified: true,
        credentials: [
          {
            type: 'password',
            value: body.password,
            temporary: false,
          },
        ],
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const location = createResp.headers.location as string | undefined;
    const userId = location?.split('/').pop();
    if (!userId) {
      const found = await this.listUsers({ search: username, max: 1 });
      if (!found[0]?.id) throw new Error('User created but id could not be resolved');
      await this.assignRole(found[0].id, this.normalizeRole(body.role));
      return this.getUser(found[0].id);
    }

    await this.assignRole(userId, this.normalizeRole(body.role));
    return this.getUser(userId);
  }

  async updateUser(userId: string, body: {
    email?: string;
    name?: string;
    enabled?: boolean;
    is_active?: boolean;
    role?: string;
  }): Promise<void> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;
    const current = await this.getUser(userId);
    const [firstName, ...lastParts] = (body.name || current.name || '').trim().split(/\s+/).filter(Boolean);

    await axios.put(
      `${url}/admin/realms/${realm}/users/${userId}`,
      {
        username: current.username,
        email: body.email ?? current.email,
        firstName: firstName || current.name || current.username,
        lastName: lastParts.join(' '),
        enabled: body.enabled ?? body.is_active ?? current.is_active,
        emailVerified: true,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (body.role) {
      for (const role of ['user', 'pro', 'admin', 'superadmin']) {
        if (current.realmRoles?.includes(role)) await this.revokeRole(userId, role);
      }
      await this.assignRole(userId, this.normalizeRole(body.role));
    }
  }

  async setPassword(userId: string, password: string, temporary = false): Promise<void> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;

    await axios.put(
      `${url}/admin/realms/${realm}/users/${userId}/reset-password`,
      {
        type: 'password',
        value: password,
        temporary,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }

  async assignRole(userId: string, roleName: string): Promise<void> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;

    const roleResp = await axios.get(
      `${url}/admin/realms/${realm}/roles/${roleName}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    await axios.post(
      `${url}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      [roleResp.data],
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }

  async revokeRole(userId: string, roleName: string): Promise<void> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;

    const roleResp = await axios.get(
      `${url}/admin/realms/${realm}/roles/${roleName}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    await axios.delete(
      `${url}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: [roleResp.data],
      },
    );
  }

  async setUserStatus(userId: string, enabled: boolean): Promise<void> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;

    await axios.put(
      `${url}/admin/realms/${realm}/users/${userId}`,
      { enabled },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }

  async deleteUser(userId: string): Promise<void> {
    const token = await this.getAdminToken();
    const { url, realm } = this.adminBase;

    await axios.delete(`${url}/admin/realms/${realm}/users/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
