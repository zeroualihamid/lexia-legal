import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  Body,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { AgentService } from './agent/agent.service';
import { PostgresService } from '../../database/postgres.service';
import { KeycloakGuard } from '../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../common/decorators/access-level.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/guards/keycloak.guard';

@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
@UseGuards(KeycloakGuard, AccessLevelGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly agentService: AgentService,
    private readonly postgresService: PostgresService,
  ) {}

  @Post('conversations')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Create a new conversation' })
  async createConversation(@CurrentUser() user: AuthUser) {
    return this.chatService.createConversation(user.userId);
  }

  @Get('conversations')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'List user conversations' })
  async listConversations(@CurrentUser() user: AuthUser) {
    return this.chatService.getConversations(user.userId);
  }

  @Get('conversations/:id/messages')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Get messages in a conversation' })
  async getMessages(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chatService.getMessages(id, user.userId);
  }

  @Get('stream/:conversationId')
  @ApiOperation({ summary: 'SSE stream for AI chat' })
  @ApiQuery({ name: 'q', required: true, description: 'Question to ask' })
  @ApiQuery({ name: 'token', required: false, description: 'Bearer token (alternative)' })
  @ApiQuery({
    name: 'caseId',
    required: false,
    description: 'Scope user-document retrieval to one case (corpus/judgments unchanged)',
  })
  async stream(
    @Param('conversationId') conversationId: string,
    @Query('q') question: string,
    @Query('caseId') caseId: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    if (caseId) {
      const row = await this.postgresService.queryOne<{ owner_id: string }>(
        `SELECT owner_id FROM cases WHERE id = $1`,
        [caseId],
      );
      if (!row) throw new NotFoundException('Case not found');
      if (row.owner_id !== user.userId) {
        throw new ForbiddenException('Access denied');
      }
    }
    await this.agentService.streamChat(conversationId, question, user, res, {
      caseId: caseId || undefined,
    });
  }

  @Patch('conversations/:id/archive')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Archive a conversation' })
  async archiveConversation(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.chatService.archiveConversation(id, user.userId);
    return { success: true };
  }
}
