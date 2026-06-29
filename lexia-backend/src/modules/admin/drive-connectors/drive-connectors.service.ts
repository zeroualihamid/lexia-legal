import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PostgresService } from '../../../database/postgres.service';
import { MinioService } from '../../storage/minio.service';
import {
  DriveAuthConfig,
  downloadDriveFile,
  listDriveFiles,
  testDriveConnection,
} from './google-drive.client';
import {
  downloadPublicDriveFile,
  listPublicDriveFolder,
  testPublicDriveConnection,
} from './public-drive.client';

interface DriveConnectorRow {
  id: string;
  name: string;
  folder_id: string;
  auth_type: 'public_link' | 'service_account' | 'access_token';
  credentials_enc: string;
  last_test_at: string | null;
  last_test_status: string | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DriveDownloadRow {
  connector_id: string;
  drive_file_id: string;
  file_name: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  minio_bucket: string | null;
  minio_key: string | null;
  downloaded_at: string;
  downloaded_by: string | null;
}

@Injectable()
export class DriveConnectorsService {
  private readonly logger = new Logger(DriveConnectorsService.name);
  private readonly algorithm = 'aes-256-cbc';
  private readonly encryptionKey: string;
  private readonly importBucket = 'raw-pdfs';

  constructor(
    private readonly postgres: PostgresService,
    private readonly configService: ConfigService,
    private readonly minio: MinioService,
  ) {
    this.encryptionKey = this.configService.get<string>('encryptionKey') || '';
  }

  /** AES-256-CBC requires exactly 32 bytes — hash whatever ENCRYPTION_KEY is set to. */
  private cipherKey(): Buffer {
    return crypto.createHash('sha256').update(this.encryptionKey).digest();
  }

  private encrypt(data: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.cipherKey(), iv);
    let encrypted = cipher.update(data, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  private decrypt(data: string): string {
    const [ivHex, encrypted] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(this.algorithm, this.cipherKey(), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  }

  private sanitize(row: DriveConnectorRow) {
    return {
      id: row.id,
      name: row.name,
      folder_id: row.folder_id,
      auth_type: row.auth_type,
      last_test_at: row.last_test_at,
      last_test_status: row.last_test_status,
      last_test_message: row.last_test_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private parseAuth(row: DriveConnectorRow): DriveAuthConfig {
    if (row.auth_type === 'public_link') {
      return { authType: 'public_link' };
    }
    const raw = JSON.parse(this.decrypt(row.credentials_enc));
    if (row.auth_type === 'access_token') {
      return { authType: 'access_token', accessToken: raw.access_token };
    }
    return { authType: 'service_account', credentials: raw };
  }

  private buildCredentialsPayload(data: {
    auth_type: 'public_link' | 'service_account' | 'access_token';
    service_account_json?: string;
    access_token?: string;
  }): string {
    if (data.auth_type === 'public_link') {
      return JSON.stringify({});
    }

    if (data.auth_type === 'access_token') {
      const token = data.access_token?.trim();
      if (!token) {
        throw new BadRequestException('access_token requis pour ce type d\'authentification');
      }
      return JSON.stringify({ access_token: token });
    }

    const raw = data.service_account_json?.trim();
    if (!raw) {
      throw new BadRequestException('JSON du compte de service requis');
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('JSON du compte de service invalide');
    }
    if (parsed.type !== 'service_account' || !parsed.client_email) {
      throw new BadRequestException('Le JSON doit être un compte de service Google valide');
    }
    return JSON.stringify(parsed);
  }

  async list(): Promise<any[]> {
    const rows = await this.postgres.query<DriveConnectorRow>(
      `SELECT * FROM drive_connectors ORDER BY created_at DESC`,
    );
    return rows.map((row) => this.sanitize(row));
  }

  async create(data: {
    name: string;
    folder_id: string;
    auth_type?: 'public_link' | 'service_account' | 'access_token';
    service_account_json?: string;
    access_token?: string;
  }): Promise<any> {
    const name = data.name?.trim();
    const folderId = data.folder_id?.trim();
    const authType = data.auth_type || 'public_link';
    if (!name) throw new BadRequestException('Nom requis');
    if (!folderId) throw new BadRequestException('ID du dossier Google Drive requis');

    const credentialsPlain = this.buildCredentialsPayload({
      auth_type: authType,
      service_account_json: data.service_account_json,
      access_token: data.access_token,
    });
    const credentialsEnc =
      authType === 'public_link' ? '{}' : this.encrypt(credentialsPlain);
    const row = await this.postgres.queryOne<DriveConnectorRow>(
      `INSERT INTO drive_connectors (name, folder_id, auth_type, credentials_enc)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, folderId, authType, credentialsEnc],
    );
    return this.sanitize(row);
  }

  async update(
    id: string,
    data: {
      name?: string;
      folder_id?: string;
      auth_type?: 'public_link' | 'service_account' | 'access_token';
      service_account_json?: string;
      access_token?: string;
    },
  ): Promise<any> {
    const existing = await this.getRow(id);
    const name = data.name?.trim() || existing.name;
    const folderId = data.folder_id?.trim() || existing.folder_id;
    const authType = data.auth_type || existing.auth_type;

    let credentialsEnc = existing.credentials_enc;
    if (data.service_account_json?.trim() || data.access_token?.trim()) {
      const credentialsPlain = this.buildCredentialsPayload({
        auth_type: authType,
        service_account_json: data.service_account_json,
        access_token: data.access_token,
      });
      credentialsEnc = this.encrypt(credentialsPlain);
    }

    const row = await this.postgres.queryOne<DriveConnectorRow>(
      `UPDATE drive_connectors
       SET name = $2, folder_id = $3, auth_type = $4, credentials_enc = $5, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, name, folderId, authType, credentialsEnc],
    );
    return this.sanitize(row);
  }

  async delete(id: string): Promise<void> {
    const result = await this.postgres.queryOne(
      `DELETE FROM drive_connectors WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!result) throw new NotFoundException('Connecteur introuvable');
  }

  private async getRow(id: string): Promise<DriveConnectorRow> {
    const row = await this.postgres.queryOne<DriveConnectorRow>(
      `SELECT * FROM drive_connectors WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Connecteur introuvable');
    return row;
  }

  async test(id: string): Promise<any> {
    const row = await this.getRow(id);
    try {
      const result =
        row.auth_type === 'public_link'
          ? await testPublicDriveConnection(row.folder_id)
          : await testDriveConnection(this.parseAuth(row), row.folder_id);
      await this.postgres.query(
        `UPDATE drive_connectors
         SET last_test_at = NOW(),
             last_test_status = 'success',
             last_test_message = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [id, result.message],
      );
      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Drive connector test failed (${id}): ${message}`);
      await this.postgres.query(
        `UPDATE drive_connectors
         SET last_test_at = NOW(),
             last_test_status = 'failed',
             last_test_message = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [id, message],
      );
      return { ok: false, fileCount: 0, message };
    }
  }

  async listFiles(
    id: string,
    folderId?: string,
    pageToken?: string,
    mimeType?: string,
  ) {
    const row = await this.getRow(id);
    const targetFolder = folderId?.trim() || row.folder_id;
    const result =
      row.auth_type === 'public_link'
        ? await listPublicDriveFolder(targetFolder, { pageToken, mimeType })
        : await listDriveFiles(this.parseAuth(row), targetFolder, { pageToken, mimeType });

    const fileIds = result.files.filter((f) => !f.isFolder).map((f) => f.id);
    const downloadMap = await this.getDownloadMap(id, fileIds);

    return {
      ...result,
      files: result.files.map((file) => {
        const dl = downloadMap.get(file.id);
        return {
          ...file,
          downloaded: !!dl,
          downloadedAt: dl?.downloaded_at,
        };
      }),
    };
  }

  private async getDownloadMap(
    connectorId: string,
    fileIds: string[],
  ): Promise<Map<string, DriveDownloadRow>> {
    const map = new Map<string, DriveDownloadRow>();
    if (!fileIds.length) return map;

    const rows = await this.postgres.query<DriveDownloadRow>(
      `SELECT * FROM drive_connector_file_downloads
       WHERE connector_id = $1 AND drive_file_id = ANY($2::text[])`,
      [connectorId, fileIds],
    );
    for (const row of rows) {
      map.set(row.drive_file_id, row);
    }
    return map;
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'download';
  }

  /** Download from Drive, store in MinIO, record in Postgres. */
  async fetchAndStoreFile(
    connectorId: string,
    fileId: string,
    userId?: string,
    options: { force?: boolean; fileNameHint?: string } = {},
  ): Promise<{
    skipped: boolean;
    downloadedAt: string;
    fileName: string;
    fileSizeBytes: number;
  }> {
    await this.getRow(connectorId);

    if (!options.force) {
      const existing = await this.postgres.queryOne<DriveDownloadRow>(
        `SELECT * FROM drive_connector_file_downloads
         WHERE connector_id = $1 AND drive_file_id = $2`,
        [connectorId, fileId],
      );
      if (existing) {
        return {
          skipped: true,
          downloadedAt: existing.downloaded_at,
          fileName: existing.file_name,
          fileSizeBytes: Number(existing.file_size_bytes || 0),
        };
      }
    }

    const file = await this.downloadFile(connectorId, fileId);
    if (options.fileNameHint && !file.fileName) {
      file.fileName = options.fileNameHint;
    }

    const safeName = this.sanitizeFileName(file.fileName);
    const minioKey = `drive-connectors/${connectorId}/${fileId}/${safeName}`;

    await this.minio.uploadFile(
      this.importBucket,
      minioKey,
      file.buffer,
      file.buffer.length,
      file.mimeType,
    );

    const row = await this.postgres.queryOne<DriveDownloadRow>(
      `INSERT INTO drive_connector_file_downloads
         (connector_id, drive_file_id, file_name, mime_type, file_size_bytes,
          minio_bucket, minio_key, downloaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (connector_id, drive_file_id) DO UPDATE SET
         file_name = EXCLUDED.file_name,
         mime_type = EXCLUDED.mime_type,
         file_size_bytes = EXCLUDED.file_size_bytes,
         minio_bucket = EXCLUDED.minio_bucket,
         minio_key = EXCLUDED.minio_key,
         downloaded_at = NOW(),
         downloaded_by = COALESCE(EXCLUDED.downloaded_by, drive_connector_file_downloads.downloaded_by)
       RETURNING *`,
      [
        connectorId,
        fileId,
        safeName,
        file.mimeType,
        file.buffer.length,
        this.importBucket,
        minioKey,
        userId || null,
      ],
    );

    return {
      skipped: false,
      downloadedAt: row.downloaded_at,
      fileName: row.file_name,
      fileSizeBytes: file.buffer.length,
    };
  }

  async downloadFileForBrowser(
    connectorId: string,
    fileId: string,
    userId?: string,
    fileNameHint?: string,
  ) {
    const stored = await this.fetchAndStoreFile(connectorId, fileId, userId, {
      fileNameHint,
    });
    const record = await this.postgres.queryOne<DriveDownloadRow>(
      `SELECT * FROM drive_connector_file_downloads
       WHERE connector_id = $1 AND drive_file_id = $2`,
      [connectorId, fileId],
    );
    if (!record?.minio_bucket || !record.minio_key) {
      throw new BadRequestException('Fichier non trouvé après enregistrement');
    }
    const buffer = await this.minio.downloadFile(record.minio_bucket, record.minio_key);
    return {
      buffer,
      mimeType: record.mime_type || 'application/octet-stream',
      fileName: stored.fileName,
      downloadedAt: stored.downloadedAt,
      skipped: stored.skipped,
    };
  }

  async downloadAll(
    connectorId: string,
    folderId: string | undefined,
    userId?: string,
    options: { skipExisting?: boolean } = {},
  ): Promise<{
    total: number;
    downloaded: number;
    skipped: number;
    failed: number;
    errors: { fileId: string; fileName: string; message: string }[];
  }> {
    const skipExisting = options.skipExisting !== false;
    const listing = await this.listFiles(connectorId, folderId);
    const targets = listing.files.filter((f) => !f.isFolder);

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;
    const errors: { fileId: string; fileName: string; message: string }[] = [];

    for (const file of targets) {
      try {
        const result = await this.fetchAndStoreFile(connectorId, file.id, userId, {
          force: !skipExisting,
          fileNameHint: file.name,
        });
        if (result.skipped) skipped += 1;
        else downloaded += 1;
      } catch (err) {
        failed += 1;
        errors.push({
          fileId: file.id,
          fileName: file.name,
          message: err instanceof Error ? err.message : String(err),
        });
        this.logger.warn(
          `Drive bulk download failed (${connectorId}/${file.id}): ${errors[errors.length - 1].message}`,
        );
      }
    }

    return {
      total: targets.length,
      downloaded,
      skipped,
      failed,
      errors,
    };
  }

  async downloadFile(id: string, fileId: string) {
    const row = await this.getRow(id);
    if (row.auth_type === 'public_link') {
      return downloadPublicDriveFile(fileId);
    }
    return downloadDriveFile(this.parseAuth(row), fileId);
  }
}
