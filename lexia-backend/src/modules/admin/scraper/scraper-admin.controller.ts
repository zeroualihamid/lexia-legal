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
import { ScraperAdminService } from './scraper-admin.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/scraper')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class ScraperAdminController {
  constructor(private readonly scraperAdminService: ScraperAdminService) {}

  @Get('sources')
  @ApiOperation({ summary: 'List scraping sources' })
  getSources() {
    return this.scraperAdminService.getSources();
  }

  @Post('sources')
  @ApiOperation({ summary: 'Create a scraping source' })
  createSource(@Body() body: any) {
    return this.scraperAdminService.createSource(body);
  }

  @Patch('sources/:id')
  @ApiOperation({ summary: 'Update a scraping source' })
  updateSource(@Param('id') id: string, @Body() body: any) {
    return this.scraperAdminService.updateSource(id, body);
  }

  @Delete('sources/:id')
  @ApiOperation({ summary: 'Delete a scraping source' })
  async deleteSource(@Param('id') id: string) {
    await this.scraperAdminService.deleteSource(id);
    return { success: true };
  }

  @Post('sources/:id/scrape')
  @ApiOperation({ summary: 'Enqueue scraping job for a source' })
  enqueueScraping(@Param('id') id: string) {
    return this.scraperAdminService.enqueueScraping(id);
  }

  @Post('scrape-by-reference/preview')
  @ApiOperation({ summary: 'Preview scrape by court file reference (no ingest)' })
  previewScrapeByReference(@Body() body: any) {
    return this.scraperAdminService.previewScrapeByReference(body);
  }

  @Post('scrape-by-reference')
  @ApiOperation({ summary: 'Enqueue scrape-by-reference job (mahakim → CSPJ routing)' })
  enqueueScrapeByReference(@Body() body: any) {
    return this.scraperAdminService.enqueueScrapeByReference(body);
  }

  @Get('monitor')
  @ApiOperation({ summary: 'Live scraping monitor (corpus progress + queue stats)' })
  getMonitor() {
    return this.scraperAdminService.getMonitor();
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List scraping jobs' })
  getJobs() {
    return this.scraperAdminService.getJobs();
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Get a specific scraping job' })
  getJob(@Param('id') id: string) {
    return this.scraperAdminService.getJob(id);
  }

  @Post('jobs/:id/cancel')
  @ApiOperation({ summary: 'Cancel a scraping job' })
  async cancelJob(@Param('id') id: string) {
    await this.scraperAdminService.cancelJob(id);
    return { success: true };
  }

  @Post('reindex/:documentId')
  @ApiOperation({ summary: 'Reindex a document' })
  reindexDocument(@Param('documentId') documentId: string) {
    return this.scraperAdminService.reindexDocument(documentId);
  }

  @Post('drain-document-queue')
  @ApiOperation({ summary: 'Vider la file document-processing (legacy OCR) et marquer les PDF prêts' })
  drainDocumentQueue() {
    return this.scraperAdminService.drainDocumentProcessingQueue();
  }

  @Post('sources/:id/resume-corpus')
  @ApiOperation({ summary: 'Reprendre le téléchargement corpus pour une source' })
  resumeCorpus(@Param('id') id: string) {
    return this.scraperAdminService.resumeCorpusSource(id);
  }

  @Post('bulk-reindex')
  @ApiOperation({ summary: 'Indexer en lot les PDF différés (phase 2)' })
  bulkReindex(@Body() body: { sourceId?: string; limit?: number }) {
    return this.scraperAdminService.bulkReindexDeferred(body);
  }
}
