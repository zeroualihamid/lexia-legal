import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('SUPERADMIN')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List users from Keycloak' })
  listUsers(
    @Query('search') search?: string,
    @Query('first') first?: number,
    @Query('max') max?: number,
  ) {
    return this.usersService.listUsers({ search, first: +first, max: +max });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user details' })
  getUser(@Param('id') id: string) {
    return this.usersService.getUser(id);
  }

  @Post(':id/roles')
  @ApiOperation({ summary: 'Assign role to user' })
  async assignRole(
    @Param('id') id: string,
    @Body('role') role: string,
  ) {
    await this.usersService.assignRole(id, role);
    return { success: true };
  }

  @Delete(':id/roles/:role')
  @ApiOperation({ summary: 'Revoke role from user' })
  async revokeRole(
    @Param('id') id: string,
    @Param('role') role: string,
  ) {
    await this.usersService.revokeRole(id, role);
    return { success: true };
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Enable or disable user' })
  async setStatus(
    @Param('id') id: string,
    @Body('enabled') enabled: boolean,
  ) {
    await this.usersService.setUserStatus(id, enabled);
    return { success: true };
  }
}
