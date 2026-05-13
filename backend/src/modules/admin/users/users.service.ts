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
    return response.data;
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

    return { ...userResp.data, realmRoles: rolesResp.data };
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
}
