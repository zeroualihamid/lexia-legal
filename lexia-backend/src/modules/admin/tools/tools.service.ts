import { Injectable, NotFoundException } from '@nestjs/common';
import { PostgresService } from '../../../database/postgres.service';
import { ToolExecutorService } from '../../chat/agent/tool-executor.service';

@Injectable()
export class ToolsService {
  constructor(
    private postgresService: PostgresService,
    private toolExecutorService: ToolExecutorService,
  ) {}

  async findAll(): Promise<any[]> {
    return this.postgresService.query(
      `SELECT * FROM tools ORDER BY created_at DESC`,
    );
  }

  async create(data: {
    name: string;
    description?: string;
    description_ar?: string;
    implementation_code: string;
    parameters_schema?: any;
    timeout_ms?: number;
    is_active?: boolean;
  }): Promise<any> {
    return this.postgresService.queryOne(
      `INSERT INTO tools
         (name, description, description_ar, implementation_code, parameters_schema, timeout_ms, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.name,
        data.description || null,
        data.description_ar || null,
        data.implementation_code,
        data.parameters_schema ? JSON.stringify(data.parameters_schema) : null,
        data.timeout_ms || 5000,
        data.is_active !== undefined ? data.is_active : true,
      ],
    );
  }

  async update(id: string, data: any): Promise<any> {
    const tool = await this.postgresService.queryOne<any>(
      `SELECT * FROM tools WHERE id = $1`,
      [id],
    );
    if (!tool) throw new NotFoundException('Tool not found');

    const updated = { ...tool, ...data };
    return this.postgresService.queryOne(
      `UPDATE tools SET
         name = $1,
         description = $2,
         description_ar = $3,
         implementation_code = $4,
         parameters_schema = $5,
         timeout_ms = $6,
         is_active = $7,
         updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        updated.name,
        updated.description,
        updated.description_ar,
        updated.implementation_code,
        updated.parameters_schema ? JSON.stringify(updated.parameters_schema) : null,
        updated.timeout_ms,
        updated.is_active,
        id,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    const result = await this.postgresService.queryOne(
      `DELETE FROM tools WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result) throw new NotFoundException('Tool not found');
  }

  async testTool(id: string, args: any): Promise<any> {
    const tool = await this.postgresService.queryOne<any>(
      `SELECT * FROM tools WHERE id = $1`,
      [id],
    );
    if (!tool) throw new NotFoundException('Tool not found');

    const startTime = Date.now();
    const result = await this.toolExecutorService.executeTool(tool, args);
    const duration = Date.now() - startTime;

    return {
      success: true,
      result,
      duration_ms: duration,
    };
  }
}
