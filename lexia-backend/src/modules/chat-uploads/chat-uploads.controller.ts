import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { KeycloakGuard } from '../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { AuthenticatedGuard } from '../../common/guards/authenticated.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/guards/keycloak.guard';
import { ChatUploadsService } from './chat-uploads.service';
import { RedisPubSubService } from '../../database/redis-pubsub.service';
import { ANALYSIS_CHANNEL } from '../admin/judgment-analysis/judgment-analysis.processor';

@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat/uploads')
@UseGuards(KeycloakGuard, AccessLevelGuard, AuthenticatedGuard)
export class ChatUploadsController {
  private readonly logger = new Logger(ChatUploadsController.name);

  constructor(
    private readonly service: ChatUploadsService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file directly in the main chat' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(file, user);
  }

  @Get()
  @ApiOperation({ summary: 'List my chat-uploaded judgments' })
  async listJudgments(@CurrentUser() user: AuthUser) {
    return this.service.listMyJudgments(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Status + classification of a chat upload' })
  async getStatus(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.getStatus(id, user.userId);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'View the original uploaded PDF' })
  async viewPdf(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const pdf = await this.service.getPdf(id, user.userId);
    const fallbackName = 'document.pdf';
    const filename = encodeURIComponent(pdf.filename || fallbackName);
    res.setHeader('Content-Type', pdf.contentType);
    res.setHeader('Content-Length', pdf.buffer.length);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${fallbackName}"; filename*=UTF-8''${filename}`,
    );
    res.send(pdf.buffer);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'Bilingual (FR/AR) summary markdown of a judgment' })
  async getSummary(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.service.getSummary(id, user.userId);
  }

  @Post(':id/link')
  @ApiOperation({ summary: 'Link a judgment upload to an existing/new case' })
  async link(
    @Param('id') id: string,
    @Body() body: { caseId?: string; newCase?: { title: string; clientName?: string } },
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.linkToCase(id, user.userId, body);
  }

  @Get(':id/summary/stream')
  @ApiOperation({ summary: 'SSE stream of the judgment summary as it is written' })
  async stream(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const analysisId = await this.service.getAnalysisId(id, user.userId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    let unsubscribe: (() => Promise<void>) | null = null;
    let closed = false;

    const finish = async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (unsubscribe) {
        try {
          await unsubscribe();
        } catch {
          /* ignore */
        }
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };
    req.on('close', finish);

    try {
      const summary = await this.service.getSummary(id, user.userId);
      if (summary.markdown) {
        this.sendSSE(res, 'replay', { content: summary.markdown });
      }
      this.sendSSE(res, 'status', { status: summary.status });

      if (summary.status === 'completed') {
        this.sendSSE(res, 'done', { markdown: summary.markdown });
        await finish();
        return;
      }
      if (summary.status === 'failed') {
        this.sendSSE(res, 'error', { message: summary.error || 'failed' });
        await finish();
        return;
      }

      unsubscribe = this.pubsub.subscribe(ANALYSIS_CHANNEL(analysisId), (payload) => {
        if (closed) return;
        const { type, ...rest } = payload || {};
        if (!type) return;
        this.sendSSE(res, type, rest);
        if (type === 'done' || type === 'error') finish();
      });
    } catch (err: any) {
      this.logger.warn(`Summary SSE failed for ${id}: ${err.message}`);
      this.sendSSE(res, 'error', { message: err.message });
      await finish();
    }
  }

  private sendSSE(res: Response, event: string, data: any): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
