import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { DocumentsService } from './documents.service';
import { KeycloakGuard } from '../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { AuthenticatedGuard } from '../../common/guards/authenticated.guard';
import { RequireAccessLevel } from '../../common/decorators/access-level.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/guards/keycloak.guard';

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('documents')
@UseGuards(KeycloakGuard, AccessLevelGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @UseGuards(AuthenticatedGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a document into a case' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'caseId'],
      properties: {
        file: { type: 'string', format: 'binary' },
        caseId: { type: 'string' },
        documentType: { type: 'string' },
        titleAr: { type: 'string' },
        titleFr: { type: 'string' },
      },
    },
  })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.uploadDocument(file, user, {
      titleAr: body.titleAr,
      titleFr: body.titleFr,
      caseId: body.caseId,
      documentType: body.documentType,
    });
  }

  @Get('my')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'List all my documents (across cases)' })
  async getMyDocuments(@CurrentUser() user: AuthUser) {
    return this.documentsService.getMyDocuments(user.userId);
  }

  @Get('quota')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Get my monthly upload quota usage' })
  async getQuota(@CurrentUser() user: AuthUser) {
    return this.documentsService.getUploadQuota(user.userId);
  }

  @Get('jobs/:jobId')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Get processing job status' })
  async getJobStatus(@Param('jobId') jobId: string) {
    return this.documentsService.getJobStatus(jobId);
  }

  @Get(':id/pdf')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'View the original PDF for my document' })
  async viewPdf(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const pdf = await this.documentsService.getOriginalPdf(id, user.userId);
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

  @Get(':id/pages')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'List rendered pages for my document' })
  async listPages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.listPages(id, user.userId);
  }

  @Get(':id/pages/:pageNumber/url')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Presigned URL for one page image of my document' })
  async getPageUrl(
    @Param('id') id: string,
    @Param('pageNumber') pageNumber: string,
    @CurrentUser() user: AuthUser,
  ) {
    const n = parseInt(pageNumber, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new BadRequestException('Numéro de page invalide');
    }
    return this.documentsService.getPageUrl(id, n, user.userId);
  }

  @Delete(':id')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Delete one of my documents' })
  async deleteDocument(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.documentsService.deleteDocument(id, user.userId);
    return { success: true };
  }

  @Patch(':id/visibility')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Update document visibility' })
  async updateVisibility(
    @Param('id') id: string,
    @Body('visibility') visibility: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.updateVisibility(id, user.userId, visibility);
  }

  @Patch(':id/document-type')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Update document type' })
  async updateDocumentType(
    @Param('id') id: string,
    @Body('documentType') documentType: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.updateDocumentType(id, user.userId, documentType);
  }

  @Patch(':id/title')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Rename document (display title)' })
  async updateDocumentTitle(
    @Param('id') id: string,
    @Body('titleAr') titleAr: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.updateDocumentTitle(id, user.userId, titleAr);
  }

  @Patch(':id/legal-classification')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Set or reset legal document classification (search library)' })
  async updateLegalClassification(
    @Param('id') id: string,
    @Body() body: { legalFamily?: string; legalClass?: string; reset?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    if (body.reset) {
      return this.documentsService.resetDocumentLegalClassification(id, user.userId);
    }
    if (!body.legalFamily || !body.legalClass) {
      throw new BadRequestException('legalFamily and legalClass are required');
    }
    return this.documentsService.updateDocumentLegalClassification(
      id,
      user.userId,
      body.legalFamily,
      body.legalClass,
    );
  }

  @Post(':id/suggest-title')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'AI-suggest a document title from opening text chunks' })
  async suggestDocumentTitle(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.suggestDocumentTitle(id, user.userId);
  }

  @Post(':id/summarize-judgment')
  @UseGuards(AuthenticatedGuard)
  @ApiOperation({ summary: 'Generate bilingual summary for a judgment document' })
  async summarizeJudgment(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.requestJudgmentSummary(id, user.userId);
  }

  @Get(':id/judgment-summary')
  @ApiOperation({ summary: 'Get saved bilingual judgment summary markdown' })
  async getJudgmentSummary(
    @Param('id') id: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.documentsService.getSharedJudgmentSummary(id, user);
  }

  // ─── Admin review ───────────────────────────────────────────

  @Get('admin/pending')
  @RequireAccessLevel('ADMIN')
  @ApiOperation({ summary: 'Get documents pending review' })
  async getPendingDocuments() {
    return this.documentsService.getPendingDocuments();
  }

  @Patch('admin/:id/approve')
  @RequireAccessLevel('ADMIN')
  @ApiOperation({ summary: 'Approve a document' })
  async approveDocument(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.approveDocument(id, user.userId);
  }

  @Patch('admin/:id/reject')
  @RequireAccessLevel('ADMIN')
  @ApiOperation({ summary: 'Reject a document' })
  async rejectDocument(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.rejectDocument(id, user.userId, reason);
  }
}
