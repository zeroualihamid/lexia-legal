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
} from '@nestjs/common';
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
  ): Promise<DocumentRow[]> {
    const lim = limit ? Math.min(parseInt(limit, 10) || 50, 500) : 100;
    const off = offset ? parseInt(offset, 10) || 0 : 0;
    const params: any[] = [lim, off];
    let where = '';
    if (status) {
      where = 'WHERE status = $3';
      params.push(status);
    }
    return this.postgres.query<DocumentRow>(
      `SELECT id, title_ar, title_fr, collection, status, visibility,
              owner_type, owner_id, page_count, pages_status,
              minio_bucket, minio_key, created_at
       FROM documents
       ${where}
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      params,
    );
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
