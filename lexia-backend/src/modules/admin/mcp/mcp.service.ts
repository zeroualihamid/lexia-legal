import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../../../database/postgres.service';
import axios from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly encryptionKey: string;
  private readonly algorithm = 'aes-256-cbc';

  constructor(
    private postgresService: PostgresService,
    private configService: ConfigService,
  ) {
    this.encryptionKey = this.configService.get<string>('encryptionKey');
  }

  private encrypt(data: string): string {
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(this.encryptionKey.slice(0, 32), 'utf-8');
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    let encrypted = cipher.update(data, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  private decrypt(data: string): string {
    const [ivHex, encrypted] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = Buffer.from(this.encryptionKey.slice(0, 32), 'utf-8');
    const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  }

  private sanitizeServer(server: any): any {
    const { auth_config, ...safe } = server;
    return safe;
  }

  async findAll(): Promise<any[]> {
    const servers = await this.postgresService.query<any>(
      `SELECT * FROM mcp_servers ORDER BY created_at DESC`,
    );
    return servers.map((s) => this.sanitizeServer(s));
  }

  async create(data: {
    name: string;
    endpoint: string;
    description?: string;
    auth_config?: any;
    is_active?: boolean;
  }): Promise<any> {
    const encryptedAuth = data.auth_config
      ? this.encrypt(JSON.stringify(data.auth_config))
      : null;

    const server = await this.postgresService.queryOne<any>(
      `INSERT INTO mcp_servers (name, endpoint, description, auth_config, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.name,
        data.endpoint,
        data.description || null,
        encryptedAuth,
        data.is_active !== undefined ? data.is_active : true,
      ],
    );

    return this.sanitizeServer(server);
  }

  async update(id: string, data: any): Promise<any> {
    const server = await this.postgresService.queryOne<any>(
      `SELECT * FROM mcp_servers WHERE id = $1`,
      [id],
    );
    if (!server) throw new NotFoundException('MCP server not found');

    const encryptedAuth =
      data.auth_config !== undefined
        ? data.auth_config
          ? this.encrypt(JSON.stringify(data.auth_config))
          : null
        : server.auth_config;

    const updated = await this.postgresService.queryOne<any>(
      `UPDATE mcp_servers SET
         name = $1,
         endpoint = $2,
         description = $3,
         auth_config = $4,
         is_active = $5,
         updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        data.name || server.name,
        data.endpoint || server.endpoint,
        data.description !== undefined ? data.description : server.description,
        encryptedAuth,
        data.is_active !== undefined ? data.is_active : server.is_active,
        id,
      ],
    );

    return this.sanitizeServer(updated);
  }

  async remove(id: string): Promise<void> {
    const result = await this.postgresService.queryOne(
      `DELETE FROM mcp_servers WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result) throw new NotFoundException('MCP server not found');
  }

  async healthCheck(id: string): Promise<any> {
    const server = await this.postgresService.queryOne<any>(
      `SELECT * FROM mcp_servers WHERE id = $1`,
      [id],
    );
    if (!server) throw new NotFoundException('MCP server not found');

    const startTime = Date.now();
    try {
      await axios.get(`${server.endpoint}/health`, { timeout: 5000 });
      const latency = Date.now() - startTime;
      return { healthy: true, latency_ms: latency, endpoint: server.endpoint };
    } catch (err) {
      return {
        healthy: false,
        error: err.message,
        endpoint: server.endpoint,
      };
    }
  }

  async discoverTools(id: string): Promise<any> {
    const server = await this.postgresService.queryOne<any>(
      `SELECT * FROM mcp_servers WHERE id = $1`,
      [id],
    );
    if (!server) throw new NotFoundException('MCP server not found');

    let authHeaders: any = {};
    if (server.auth_config) {
      try {
        const authConfig = JSON.parse(this.decrypt(server.auth_config));
        if (authConfig.type === 'bearer') {
          authHeaders['Authorization'] = `Bearer ${authConfig.token}`;
        } else if (authConfig.type === 'api_key') {
          authHeaders[authConfig.header || 'X-API-Key'] = authConfig.key;
        }
      } catch {
        // no auth
      }
    }

    const response = await axios.get(`${server.endpoint}/tools`, {
      headers: authHeaders,
      timeout: 10000,
    });

    const tools = response.data?.tools || response.data || [];

    // Save tools schema to server record
    await this.postgresService.query(
      `UPDATE mcp_servers SET tools_schema = $1 WHERE id = $2`,
      [JSON.stringify(tools), id],
    );

    return { tools };
  }

  async healthCheckAll(): Promise<any[]> {
    const servers = await this.postgresService.query<any>(
      `SELECT id FROM mcp_servers WHERE is_active = true`,
    );

    return Promise.all(servers.map((s) => this.healthCheck(s.id)));
  }
}
