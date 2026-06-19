import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { AuthenticatedGuard } from '../../common/guards/authenticated.guard';
import {
  AuthUser,
  KeycloakGuard,
} from '../../common/guards/keycloak.guard';
import { TasksService } from './tasks.service';

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
@UseGuards(KeycloakGuard, AccessLevelGuard, AuthenticatedGuard)
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  @ApiOperation({ summary: 'List my Redis-backed upload tasks' })
  async list(@CurrentUser() user: AuthUser) {
    return this.tasksService.listUploadTasks(user.userId);
  }
}
