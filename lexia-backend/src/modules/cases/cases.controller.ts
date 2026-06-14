import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CasesService } from './cases.service';
import { AgentService } from '../chat/agent/agent.service';
import { KeycloakGuard } from '../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { AuthenticatedGuard } from '../../common/guards/authenticated.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/guards/keycloak.guard';

@ApiTags('Cases')
@ApiBearerAuth()
@Controller('cases')
@UseGuards(KeycloakGuard, AccessLevelGuard, AuthenticatedGuard)
export class CasesController {
  constructor(
    private readonly casesService: CasesService,
    private readonly agentService: AgentService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a case' })
  async create(@Body() body: any, @CurrentUser() user: AuthUser) {
    return this.casesService.create(user.userId, {
      title: body.title,
      clientName: body.clientName,
      caseRef: body.caseRef,
      description: body.description,
      status: body.status,
      courtType: body.courtType,
      courtName: body.courtName,
      fileNumber: body.fileNumber,
      fileCode: body.fileCode,
      fileYear: body.fileYear,
      courtSection: body.courtSection,
      courtPanel: body.courtPanel,
      caseCategory: body.caseCategory,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List my cases' })
  async list(@CurrentUser() user: AuthUser) {
    return this.casesService.list(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one case' })
  async get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.casesService.get(id, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a case' })
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.casesService.update(id, user.userId, {
      title: body.title,
      clientName: body.clientName,
      caseRef: body.caseRef,
      description: body.description,
      status: body.status,
      courtType: body.courtType,
      courtName: body.courtName,
      fileNumber: body.fileNumber,
      fileCode: body.fileCode,
      fileYear: body.fileYear,
      courtSection: body.courtSection,
      courtPanel: body.courtPanel,
      caseCategory: body.caseCategory,
    });
  }

  @Post(':id/mahakim/refresh')
  @ApiOperation({ summary: 'Re-fetch case status from mahakim.ma (background)' })
  async refreshMahakim(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.casesService.refreshMahakim(id, user.userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a case and all its documents' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.casesService.remove(id, user.userId);
    return { success: true };
  }

  @Get(':id/documents')
  @ApiOperation({ summary: 'List documents in a case' })
  async listDocuments(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.casesService.listDocuments(id, user.userId);
  }

  @Post(':id/search')
  @ApiOperation({ summary: 'Semantic search within a case' })
  async search(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.casesService.search(
      id,
      user.userId,
      body.query || '',
      body.limit || 10,
    );
  }

  @Get(':id/chat/stream')
  @ApiOperation({ summary: 'SSE chat grounded in a case + global corpus' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'token', required: false })
  async chatStream(
    @Param('id') id: string,
    @Query('q') question: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    // Verify ownership before streaming (throws 403/404 if not owner).
    await this.casesService.get(id, user.userId);
    // Strategic-query detection: if the lawyer typed a court-file reference,
    // persist it onto the case and (re)trigger the mahakim.ma lookup before the
    // answer streams, so the assistant can acknowledge and reason about it.
    let referenceCapture = null;
    try {
      referenceCapture = await this.casesService.captureReferenceFromText(
        id,
        user.userId,
        question,
      );
    } catch {
      referenceCapture = null;
    }
    await this.agentService.streamScopedChat(id, question, user, res, {
      referenceCapture,
    });
  }
}
