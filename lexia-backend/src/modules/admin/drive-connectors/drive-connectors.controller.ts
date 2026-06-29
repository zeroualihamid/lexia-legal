import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
} from '@nestjs/swagger';
import { Response } from 'express';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthUser } from '../../../common/guards/keycloak.guard';
import { DriveConnectorsService } from './drive-connectors.service';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/drive-connectors')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class DriveConnectorsController {
  constructor(private readonly driveConnectors: DriveConnectorsService) {}

  @Get()
  @ApiOperation({ summary: 'Lister les connecteurs Google Drive' })
  list() {
    return this.driveConnectors.list();
  }

  @Post()
  @ApiOperation({ summary: 'Créer un connecteur Google Drive' })
  create(
    @Body()
    body: {
      name?: string;
      folder_id?: string;
      auth_type?: 'public_link' | 'service_account' | 'access_token';
      service_account_json?: string;
      access_token?: string;
    },
  ) {
    return this.driveConnectors.create({
      name: body.name || '',
      folder_id: body.folder_id || '',
      auth_type: body.auth_type || 'public_link',
      service_account_json: body.service_account_json,
      access_token: body.access_token,
    });
  }

  @Put(':id')
  @ApiOperation({ summary: 'Mettre à jour un connecteur Google Drive' })
  update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      folder_id?: string;
      auth_type?: 'public_link' | 'service_account' | 'access_token';
      service_account_json?: string;
      access_token?: string;
    },
  ) {
    return this.driveConnectors.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un connecteur Google Drive' })
  async remove(@Param('id') id: string) {
    await this.driveConnectors.delete(id);
    return { ok: true };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Tester la connexion Google Drive' })
  test(@Param('id') id: string) {
    return this.driveConnectors.test(id);
  }

  @Get(':id/files')
  @ApiOperation({ summary: 'Lister les fichiers d\'un dossier Google Drive' })
  listFiles(
    @Param('id') id: string,
    @Query('folderId') folderId?: string,
    @Query('pageToken') pageToken?: string,
    @Query('mimeType') mimeType?: string,
  ) {
    return this.driveConnectors.listFiles(id, folderId, pageToken, mimeType);
  }

  @Get(':id/files/:fileId/download')
  @ApiOperation({ summary: 'Télécharger un fichier Google Drive' })
  async download(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Query('fileName') fileName: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const file = await this.driveConnectors.downloadFileForBrowser(
      id,
      fileId,
      user.userId,
      fileName,
    );
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.fileName)}"`,
    );
    res.setHeader('X-Drive-Downloaded-At', file.downloadedAt);
    res.send(file.buffer);
  }

  @Post(':id/files/:fileId/fetch')
  @ApiOperation({ summary: 'Télécharger et enregistrer un fichier Google Drive' })
  fetchFile(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Body() body: { fileName?: string; force?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    return this.driveConnectors.fetchAndStoreFile(id, fileId, user.userId, {
      fileNameHint: body?.fileName,
      force: body?.force === true,
    });
  }

  @Post(':id/download-all')
  @ApiOperation({ summary: 'Télécharger tous les fichiers du dossier courant' })
  downloadAll(
    @Param('id') id: string,
    @Body() body: { folderId?: string; skipExisting?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    return this.driveConnectors.downloadAll(id, body?.folderId, user.userId, {
      skipExisting: body?.skipExisting !== false,
    });
  }
}
