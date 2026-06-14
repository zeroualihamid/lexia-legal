import { Injectable, NotFoundException } from '@nestjs/common';
import { PostgresService } from '../../../database/postgres.service';

@Injectable()
export class AgentConfigService {
  constructor(private postgresService: PostgresService) {}

  async findAll(): Promise<any[]> {
    return this.postgresService.query(
      `SELECT ac.*,
         json_agg(DISTINCT s.id) FILTER (WHERE s.id IS NOT NULL) as skill_ids,
         json_agg(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL) as tool_ids,
         json_agg(DISTINCT m.id) FILTER (WHERE m.id IS NOT NULL) as mcp_server_ids
       FROM agent_configs ac
       LEFT JOIN agent_config_skills acs ON acs.agent_config_id = ac.id
       LEFT JOIN skills s ON s.id = acs.skill_id
       LEFT JOIN agent_config_tools act ON act.agent_config_id = ac.id
       LEFT JOIN tools t ON t.id = act.tool_id
       LEFT JOIN agent_config_mcp acm ON acm.agent_config_id = ac.id
       LEFT JOIN mcp_servers m ON m.id = acm.mcp_server_id
       GROUP BY ac.id
       ORDER BY ac.is_default DESC, ac.created_at DESC`,
    );
  }

  async create(data: {
    name: string;
    model?: string;
    system_prompt?: string;
    skill_ids?: string[];
    tool_ids?: string[];
    mcp_server_ids?: string[];
    is_default?: boolean;
  }): Promise<any> {
    return this.postgresService.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO agent_configs (name, model, system_prompt, is_default)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          data.name,
          data.model || 'gpt-4o',
          data.system_prompt || null,
          data.is_default || false,
        ],
      );
      const config = result.rows[0];

      await this.syncRelations(client, config.id, data);
      return config;
    });
  }

  async update(id: string, data: any): Promise<any> {
    const config = await this.postgresService.queryOne<any>(
      `SELECT * FROM agent_configs WHERE id = $1`,
      [id],
    );
    if (!config) throw new NotFoundException('Agent config not found');

    return this.postgresService.transaction(async (client) => {
      const result = await client.query(
        `UPDATE agent_configs SET
           name = $1, model = $2, system_prompt = $3, is_default = $4, updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [
          data.name || config.name,
          data.model || config.model,
          data.system_prompt !== undefined ? data.system_prompt : config.system_prompt,
          data.is_default !== undefined ? data.is_default : config.is_default,
          id,
        ],
      );
      const updated = result.rows[0];
      await this.syncRelations(client, id, data);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    const result = await this.postgresService.queryOne(
      `DELETE FROM agent_configs WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result) throw new NotFoundException('Agent config not found');
  }

  async setDefault(id: string): Promise<any> {
    return this.postgresService.transaction(async (client) => {
      await client.query(`UPDATE agent_configs SET is_default = false`);
      const result = await client.query(
        `UPDATE agent_configs SET is_default = true WHERE id = $1 RETURNING *`,
        [id],
      );
      if (result.rows.length === 0) throw new NotFoundException('Agent config not found');
      return result.rows[0];
    });
  }

  private async syncRelations(client: any, configId: string, data: any): Promise<void> {
    if (data.skill_ids !== undefined) {
      await client.query(
        `DELETE FROM agent_config_skills WHERE agent_config_id = $1`,
        [configId],
      );
      for (const skillId of data.skill_ids || []) {
        await client.query(
          `INSERT INTO agent_config_skills (agent_config_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [configId, skillId],
        );
      }
    }

    if (data.tool_ids !== undefined) {
      await client.query(
        `DELETE FROM agent_config_tools WHERE agent_config_id = $1`,
        [configId],
      );
      for (const toolId of data.tool_ids || []) {
        await client.query(
          `INSERT INTO agent_config_tools (agent_config_id, tool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [configId, toolId],
        );
      }
    }

    if (data.mcp_server_ids !== undefined) {
      await client.query(
        `DELETE FROM agent_config_mcp WHERE agent_config_id = $1`,
        [configId],
      );
      for (const mcpId of data.mcp_server_ids || []) {
        await client.query(
          `INSERT INTO agent_config_mcp (agent_config_id, mcp_server_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [configId, mcpId],
        );
      }
    }
  }
}
