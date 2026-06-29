import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Query,
  NotFoundException,
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
import { DocumentsService } from '../../documents/documents.service';
import { PostgresService } from '../../../database/postgres.service';
import { MinioService } from '../../storage/minio.service';
import { UsersService } from '../users/users.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthUser } from '../../../common/guards/keycloak.guard';

interface DocumentRow {
  id: string;
  title_ar: string;
  title_fr: string | null;
  collection: string;
  status: string;
  visibility: string;
  owner_type: string;
  owner_id: string | null;
  page_count: number | null;
  pages_status: string | null;
  minio_bucket: string;
  minio_key: string;
  created_at: string;
}

interface AdminDocumentListItem extends DocumentRow {
  uploaded_by: string | null;
  uploaded_by_email: string | null;
  analysis_status: string | null;
  summary_ready: boolean;
}

interface DocumentPageRow {
  id: string;
  document_id: string;
  page_number: number;
  minio_bucket: string;
  minio_key: string;
  width: number | null;
  height: number | null;
}

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/documents')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class AdminDocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly postgres: PostgresService,
    private readonly minio: MinioService,
    private readonly usersService: UsersService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Admin: upload a legal document PDF' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        collection: { type: 'string' },
        title_ar: { type: 'string' },
        title_fr: { type: 'string' },
        visibility: {
          type: 'string',
          enum: ['public', 'private', 'pro_only'],
        },
      },
    },
  })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('Aucun fichier fourni');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Seuls les fichiers PDF sont acceptés');
    }
    return this.documentsService.uploadDocument(file, user, {
      collection: body.collection,
      titleAr: body.title_ar,
      titleFr: body.title_fr,
      visibility: body.visibility,
      sourceType: 'pdf_upload',
      ownerTypeOverride: 'system',
    });
  }

  @Get()
  @ApiOperation({ summary: 'Admin: list all documents (paginated)' })
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
    @Query('meta') meta?: string,
  ): Promise<AdminDocumentListItem[] | { items: AdminDocumentListItem[]; total: number; pendingReview: number; limit: number; offset: number }> {
    const lim = limit ? Math.min(parseInt(limit, 10) || 50, 500) : 100;
    const off = offset ? parseInt(offset, 10) || 0 : 0;
    const withMeta = meta === '1' || meta === 'true';
    const params: any[] = [lim, off];
    let where = '';
    if (status) {
      where = 'WHERE d.status = $3';
      params.push(status);
    }
    const rows = await this.postgres.query<DocumentRow & {
      analysis_status: string | null;
      summary_ready: boolean;
    }>(
      `SELECT d.id, d.title_ar, d.title_fr, d.collection, d.status, d.visibility,
              d.owner_type, d.owner_id, d.page_count, d.pages_status,
              d.minio_bucket, d.minio_key, d.created_at,
              ja.status AS analysis_status,
              (ja.status = 'completed') AS summary_ready
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT j.status
         FROM judgment_analyses j
         WHERE (
           (d.metadata->>'analysisId' IS NOT NULL AND j.id = (d.metadata->>'analysisId')::uuid)
           OR (j.pdf_bucket = d.minio_bucket AND j.pdf_key = d.minio_key)
         )
           AND j.status IN ('pending', 'running', 'completed', 'failed')
         ORDER BY
           CASE j.status
             WHEN 'completed' THEN 0
             WHEN 'running' THEN 1
             WHEN 'pending' THEN 2
             WHEN 'failed' THEN 3
             ELSE 4
           END,
           j.completed_at DESC NULLS LAST,
           j.created_at DESC
         LIMIT 1
       ) ja ON true
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $1 OFFSET $2`,
      params,
    );

    const ownerIds = rows
      .filter((r) => r.owner_id)
      .map((r) => r.owner_id as string);
    const owners = await this.usersService.getUsersBriefMap(ownerIds);

    const items = rows.map((row) => {
      const owner = row.owner_id ? owners.get(row.owner_id) : null;
      let uploadedBy: string | null = null;
      if (row.owner_type === 'system') {
        uploadedBy = null;
      } else if (owner) {
        uploadedBy = owner.username || owner.email || owner.name;
      } else if (row.owner_id) {
        uploadedBy = row.owner_id;
      }

      return {
        ...row,
        uploaded_by: uploadedBy,
        uploaded_by_email: owner?.email || null,
        analysis_status: row.analysis_status ?? null,
        summary_ready: !!row.summary_ready,
      };
    });

    if (!withMeta) {
      return items;
    }

    if (status) {
      const filtered = await this.postgres.queryOne<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM documents WHERE status = $1`,
        [status],
      );
      return {
        items,
        total: filtered?.total ?? 0,
        pendingReview: status === 'pending_review' ? (filtered?.total ?? 0) : 0,
        limit: lim,
        offset: off,
      };
    }

    const counts = await this.postgres.queryOne<{ total: number; pending_review: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'pending_review')::int AS pending_review
       FROM documents`,
    );

    return {
      items,
      total: counts?.total ?? 0,
      pendingReview: counts?.pending_review ?? 0,
      limit: lim,
      offset: off,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: fetch one document with metadata' })
  async getOne(@Param('id') id: string): Promise<DocumentRow> {
    const row = await this.postgres.queryOne<DocumentRow>(
      `SELECT id, title_ar, title_fr, collection, status, visibility,
              owner_type, owner_id, page_count, pages_status,
              minio_bucket, minio_key, created_at
       FROM documents WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Document introuvable');
    return row;
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Admin: approve a document' })
  async approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.documentsService.approveDocument(id, user.userId);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Admin: reject a document' })
  async reject(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.rejectDocument(id, user.userId, reason || '');
  }

  // ─── Page rendering / viewer endpoints ──────────────────────

  @Get(':id/pdf')
  @ApiOperation({ summary: 'View or download the original PDF file' })
  async viewPdf(@Param('id') id: string, @Res() res: Response) {
    const pdf = await this.documentsService.getOriginalPdf(id);
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
  @ApiOperation({ summary: 'List rendered pages for a document' })
  async listPages(@Param('id') id: string): Promise<{
    pages: Array<Pick<DocumentPageRow, 'page_number' | 'width' | 'height'>>;
    pagesStatus: string | null;
    pageCount: number | null;
  }> {
    const meta = await this.postgres.queryOne<{
      page_count: number | null;
      pages_status: string | null;
    }>(
      `SELECT page_count, pages_status FROM documents WHERE id = $1`,
      [id],
    );
    if (!meta) throw new NotFoundException('Document introuvable');

    const pages = await this.postgres.query<DocumentPageRow>(
      `SELECT id, document_id, page_number, minio_bucket, minio_key, width, height
       FROM document_pages
       WHERE document_id = $1
       ORDER BY page_number ASC`,
      [id],
    );

    return {
      pages: pages.map((p) => ({
        page_number: p.page_number,
        width: p.width,
        height: p.height,
      })),
      pagesStatus: meta.pages_status,
      pageCount: meta.page_count,
    };
  }

  @Get(':id/pages/:pageNumber/url')
  @ApiOperation({ summary: 'Get a presigned URL for one page image' })
  async getPageUrl(
    @Param('id') id: string,
    @Param('pageNumber') pageNumber: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const n = parseInt(pageNumber, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new BadRequestException('Numéro de page invalide');
    }

    const page = await this.postgres.queryOne<DocumentPageRow>(
      `SELECT id, document_id, page_number, minio_bucket, minio_key, width, height
       FROM document_pages
       WHERE document_id = $1 AND page_number = $2`,
      [id, n],
    );
    if (!page) throw new NotFoundException('Page introuvable');

    const expiresIn = 3600;
    const url = await this.minio.getPresignedUrl(
      page.minio_bucket,
      page.minio_key,
      expiresIn,
    );
    return { url, expiresIn };
  }
}
