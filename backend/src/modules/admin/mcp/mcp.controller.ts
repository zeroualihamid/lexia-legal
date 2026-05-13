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
import { McpService } from './mcp.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/mcp')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @Get()
  @ApiOperation({ summary: 'List all MCP servers' })
  findAll() {
    return this.mcpService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Register an MCP server' })
  create(@Body() body: any) {
    return this.mcpService.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an MCP server' })
  update(@Param('id') id: string, @Body() body: any) {
    return this.mcpService.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an MCP server' })
  async remove(@Param('id') id: string) {
    await this.mcpService.remove(id);
    return { success: true };
  }

  @Post(':id/health-check')
  @ApiOperation({ summary: 'Health check a specific MCP server' })
  healthCheck(@Param('id') id: string) {
    return this.mcpService.healthCheck(id);
  }

  @Post(':id/discover-tools')
  @ApiOperation({ summary: 'Discover tools from MCP server' })
  discoverTools(@Param('id') id: string) {
    return this.mcpService.discoverTools(id);
  }

  @Post('health-check-all')
  @ApiOperation({ summary: 'Health check all MCP servers' })
  healthCheckAll() {
    return this.mcpService.healthCheckAll();
  }
}
