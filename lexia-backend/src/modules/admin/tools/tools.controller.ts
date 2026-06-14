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
import { ToolsService } from './tools.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/tools')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class ToolsController {
  constructor(private readonly toolsService: ToolsService) {}

  @Get()
  @ApiOperation({ summary: 'List all tools' })
  findAll() {
    return this.toolsService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a tool' })
  create(@Body() body: any) {
    return this.toolsService.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a tool' })
  update(@Param('id') id: string, @Body() body: any) {
    return this.toolsService.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a tool' })
  async remove(@Param('id') id: string) {
    await this.toolsService.remove(id);
    return { success: true };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test a tool in sandbox' })
  testTool(@Param('id') id: string, @Body('args') args: any) {
    return this.toolsService.testTool(id, args);
  }
}
