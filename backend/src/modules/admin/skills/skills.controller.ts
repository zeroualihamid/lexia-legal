import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SkillsService } from './skills.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/skills')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Get()
  @ApiOperation({ summary: 'List all skills' })
  findAll() {
    return this.skillsService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a skill' })
  create(@Body() body: any) {
    return this.skillsService.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a skill' })
  update(@Param('id') id: string, @Body() body: any) {
    return this.skillsService.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a skill' })
  async remove(@Param('id') id: string) {
    await this.skillsService.remove(id);
    return { success: true };
  }

  @Post('reorder')
  @ApiOperation({ summary: 'Reorder skills' })
  async reorder(@Body('ids') ids: string[]) {
    await this.skillsService.reorder(ids);
    return { success: true };
  }
}
