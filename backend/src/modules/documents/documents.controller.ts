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
  Query,
} from '@nestjs/common';
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
  @RequireAccessLevel('PRO')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a document for processing' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        titleAr: { type: 'string' },
        titleFr: { type: 'string' },
        visibility: { type: 'string', enum: ['public', 'private', 'pro_only'] },
      },
    },
  })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.uploadDocument(file, user, {
      visibility: body.visibility,
      titleAr: body.titleAr,
      titleFr: body.titleFr,
    });
  }

  @Get('my')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'List my documents' })
  async getMyDocuments(@CurrentUser() user: AuthUser) {
    return this.documentsService.getMyDocuments(user.userId);
  }

  @Get('jobs/:jobId')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Get processing job status' })
  async getJobStatus(@Param('jobId') jobId: string) {
    return this.documentsService.getJobStatus(jobId);
  }

  @Delete(':id')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Delete a document' })
  async deleteDocument(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.documentsService.deleteDocument(id, user.userId);
    return { success: true };
  }

  @Patch(':id/visibility')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Update document visibility' })
  async updateVisibility(
    @Param('id') id: string,
    @Body('visibility') visibility: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.documentsService.updateVisibility(id, user.userId, visibility);
  }

  @Get('admin/pending')
  @RequireAccessLevel('ADMIN')
  @ApiOperation({ summary: 'Get documents pending review' })
  async getPendingDocuments() {
    return this.documentsService.getPendingDocuments();
  }

  @Patch('admin/:id/approve')
  @RequireAccessLevel('ADMIN')
  @ApiOperation({ summary: 'Approve a document' })
  async approveDocument(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
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
