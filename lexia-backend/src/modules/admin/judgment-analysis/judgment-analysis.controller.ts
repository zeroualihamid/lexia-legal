import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Res,
  Req,
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
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthUser } from '../../../common/guards/keycloak.guard';
import { JudgmentAnalysisService } from './judgment-analysis.service';
import { RedisPubSubService } from '../../../database/redis-pubsub.service';
import { ANALYSIS_CHANNEL } from './judgment-analysis.processor';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/judgment-analysis')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class JudgmentAnalysisController {
  private readonly logger = new Logger(JudgmentAnalysisController.name);

  constructor(
    private readonly service: JudgmentAnalysisService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Upload a judgment PDF and start analysis' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(file, user);
  }

  @Get()
  @ApiOperation({ summary: 'List past judgment analyses' })
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.list(
      limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50,
      offset ? parseInt(offset, 10) || 0 : 0,
    );
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'View the original uploaded judgment PDF' })
  async viewPdf(@Param('id') id: string, @Res() res: Response) {
    const pdf = await this.service.getPdf(id);
    const fallbackName = 'judgment.pdf';
    const filename = encodeURIComponent(pdf.filename || fallbackName);

    res.setHeader('Content-Type', pdf.contentType);
    res.setHeader('Content-Length', pdf.buffer.length);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${fallbackName}"; filename*=UTF-8''${filename}`,
    );
    res.send(pdf.buffer);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single judgment analysis' })
  async getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  @Post(':id/rerun')
  @ApiOperation({ summary: 'Re-run analysis on the same PDF' })
  async rerun(@Param('id') id: string) {
    return this.service.rerun(id);
  }

  @Get(':id/stream')
  @ApiOperation({
    summary: 'SSE stream of analysis output (live chunks + final markdown)',
  })
  async stream(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

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
      const row = await this.service.getOne(id);

      // 1. Replay current state so reconnecting clients catch up.
      if (row.markdown_result) {
        this.sendSSE(res, 'replay', { content: row.markdown_result });
      }
      this.sendSSE(res, 'status', { status: row.status });

      // 2. If already done/failed, terminate immediately.
      if (row.status === 'completed') {
        this.sendSSE(res, 'done', { markdown: row.markdown_result || '' });
        await finish();
        return;
      }
      if (row.status === 'failed') {
        this.sendSSE(res, 'error', { message: row.error_message || 'failed' });
        await finish();
        return;
      }

      // 3. Subscribe to live updates from the worker.
      unsubscribe = this.pubsub.subscribe(ANALYSIS_CHANNEL(id), (payload) => {
        if (closed) return;
        const { type, ...rest } = payload || {};
        if (!type) return;
        this.sendSSE(res, type, rest);
        if (type === 'done' || type === 'error') {
          finish();
        }
      });
    } catch (err: any) {
      this.logger.warn(`SSE setup failed for ${id}: ${err.message}`);
      this.sendSSE(res, 'error', { message: err.message });
      await finish();
    }
  }

  private sendSSE(res: Response, event: string, data: any): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
