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
import { AgentConfigService } from './agent-config.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/agent-config')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class AgentConfigController {
  constructor(private readonly agentConfigService: AgentConfigService) {}

  @Get()
  @ApiOperation({ summary: 'List all agent configs' })
  findAll() {
    return this.agentConfigService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create an agent config' })
  create(@Body() body: any) {
    return this.agentConfigService.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an agent config' })
  update(@Param('id') id: string, @Body() body: any) {
    return this.agentConfigService.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an agent config' })
  async remove(@Param('id') id: string) {
    await this.agentConfigService.remove(id);
    return { success: true };
  }

  @Post(':id/set-default')
  @ApiOperation({ summary: 'Set this config as default' })
  setDefault(@Param('id') id: string) {
    return this.agentConfigService.setDefault(id);
  }
}
