import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { KeycloakGuard } from '../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { AuthenticatedGuard } from '../../common/guards/authenticated.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/guards/keycloak.guard';
import { ChatUploadsService } from '../chat-uploads/chat-uploads.service';
import { DocumentsService } from '../documents/documents.service';
import { RedisPubSubService } from '../../database/redis-pubsub.service';
import { ANALYSIS_CHANNEL } from '../admin/judgment-analysis/judgment-analysis.processor';

@ApiTags('Search')
@ApiBearerAuth()
@Controller('search')
@UseGuards(KeycloakGuard, AccessLevelGuard)
export class SearchController {
  private readonly logger = new Logger(SearchController.name);

  constructor(
    private readonly searchService: SearchService,
    private readonly chatUploadsService: ChatUploadsService,
    private readonly documentsService: DocumentsService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Search legal documents' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'collection', required: false })
  @ApiQuery({ name: 'legalFamily', required: false })
  @ApiQuery({ name: 'legalClass', required: false })
  @ApiQuery({ name: 'mode', required: false, enum: ['hybrid', 'semantic', 'fulltext'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async search(
    @Query('q') query: string,
    @Query('collection') collection?: string,
    @Query('mode') mode: string = 'hybrid',
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
    @Query('legalFamily') legalFamily?: string,
    @Query('legalClass') legalClass?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.searchService.search(
      query,
      collection,
      mode,
      +page,
      +limit,
      user,
      legalFamily,
      legalClass,
    );
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Autocomplete suggestions' })
  @ApiQuery({ name: 'q', required: true })
  async suggest(@Query('q') query: string) {
    return this.searchService.suggest(query);
  }

  @Get('files')
  @ApiOperation({ summary: 'List accessible MinIO-backed document files' })
  @ApiQuery({ name: 'collection', required: false })
  @ApiQuery({ name: 'legalFamily', required: false })
  @ApiQuery({ name: 'legalClass', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async listFiles(
    @Query('collection') collection?: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 24,
    @Query('legalFamily') legalFamily?: string,
    @Query('legalClass') legalClass?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.searchService.listFiles(
      collection,
      +page,
      +limit,
      user,
      legalFamily,
      legalClass,
    );
  }

  @Post('upload')
  @UseGuards(AuthenticatedGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a PDF to the search library (Redis-backed processing)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chatUploadsService.create(file, user, 'search');
  }

  @Get('document/:id')
  @ApiOperation({ summary: 'Get document detail' })
  async getDocument(
    @Param('id') id: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.searchService.getDocument(id, user);
  }

  @Post('documents/:id/summarize-judgment')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({
    summary: 'Generate shared bilingual judgment summary (saved for all users)',
  })
  async summarizeJudgment(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.requestSharedJudgmentSummary(id, user);
  }

  @Get('documents/:id/judgment-summary')
  @ApiOperation({ summary: 'Get shared bilingual judgment summary markdown' })
  async getJudgmentSummary(
    @Param('id') id: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.documentsService.getSharedJudgmentSummary(id, user);
  }

  @Get('documents/:id/judgment-summary/stream')
  @ApiOperation({ summary: 'SSE stream of shared judgment summary' })
  async streamJudgmentSummary(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const analysisId = await this.documentsService.getSharedJudgmentAnalysisId(
      id,
      user,
    );

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
      const summary = await this.documentsService.getSharedJudgmentSummary(
        id,
        user,
      );
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
      this.logger.warn(`Judgment summary SSE failed for ${id}: ${err.message}`);
      this.sendSSE(res, 'error', { message: err.message });
      await finish();
    }
  }

  private sendSSE(res: Response, event: string, data: any): void {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
