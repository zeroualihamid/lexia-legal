import { Injectable, NotFoundException } from '@nestjs/common';
import { PostgresService } from '../../../database/postgres.service';

@Injectable()
export class SkillsService {
  constructor(private postgresService: PostgresService) {}

  async findAll(): Promise<any[]> {
    return this.postgresService.query(
      `SELECT * FROM skills ORDER BY sort_order ASC, created_at ASC`,
    );
  }

  async create(data: {
    name: string;
    description_ar?: string;
    prompt_content: string;
    is_active?: boolean;
    sort_order?: number;
  }): Promise<any> {
    return this.postgresService.queryOne(
      `INSERT INTO skills (name, description_ar, prompt_content, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        data.name,
        data.description_ar || null,
        data.prompt_content,
        data.is_active !== undefined ? data.is_active : true,
        data.sort_order || 0,
      ],
    );
  }

  async update(id: string, data: Partial<{
    name: string;
    description_ar: string;
    prompt_content: string;
    is_active: boolean;
    sort_order: number;
  }>): Promise<any> {
    const skill = await this.postgresService.queryOne<any>(
      `SELECT * FROM skills WHERE id = $1`,
      [id],
    );
    if (!skill) throw new NotFoundException('Skill not found');

    const updated = { ...skill, ...data };
    return this.postgresService.queryOne(
      `UPDATE skills SET
         name = $1,
         description_ar = $2,
         prompt_content = $3,
         is_active = $4,
         sort_order = $5,
         updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        updated.name,
        updated.description_ar,
        updated.prompt_content,
        updated.is_active,
        updated.sort_order,
        id,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    const skill = await this.postgresService.queryOne(
      `DELETE FROM skills WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!skill) throw new NotFoundException('Skill not found');
  }

  async reorder(ids: string[]): Promise<void> {
    await this.postgresService.transaction(async (client) => {
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          `UPDATE skills SET sort_order = $1 WHERE id = $2`,
          [i, ids[i]],
        );
      }
    });
  }
}
