import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import { Readable } from 'stream';

const BUCKETS = [
  'raw-pdfs',
  'ocr-output',
  'scraped-html',
  'user-uploads',
  'exports',
  'invoices',
  'judgments',
];

const getErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

@Injectable()
export class MinioService implements OnModuleInit {
  private client: Minio.Client;
  // Separate client used only for signing presigned URLs against a
  // browser-reachable host (the internal endpoint isn't resolvable client-side).
  private presignClient: Minio.Client;
  private readonly logger = new Logger(MinioService.name);

  constructor(private configService: ConfigService) {
    this.client = new Minio.Client({
      endPoint: this.configService.get<string>('minio.endPoint'),
      port: this.configService.get<number>('minio.port'),
      useSSL: this.configService.get<boolean>('minio.useSSL'),
      accessKey: this.configService.get<string>('minio.accessKey'),
      secretKey: this.configService.get<string>('minio.secretKey'),
    });

    const publicEndpoint = this.configService.get<string>('minio.publicEndpoint');
    const internalEndpoint = this.configService.get<string>('minio.endPoint');
    if (publicEndpoint && publicEndpoint !== internalEndpoint) {
      this.presignClient = new Minio.Client({
        endPoint: publicEndpoint,
        port: this.configService.get<number>('minio.publicPort'),
        useSSL: this.configService.get<boolean>('minio.publicUseSSL'),
        accessKey: this.configService.get<string>('minio.accessKey'),
        secretKey: this.configService.get<string>('minio.secretKey'),
        // Pin the region so presigning never triggers a getBucketRegion()
        // network call to the (backend-unreachable) public endpoint.
        region: this.configService.get<string>('minio.region') || 'us-east-1',
      });
    } else {
      this.presignClient = this.client;
    }
  }

  async onModuleInit() {
    await this.initBuckets();
  }

  async initBuckets(): Promise<void> {
    try {
      await this.client.listBuckets();
    } catch (err) {
      this.logger.warn(
        `Skipping MinIO bucket init: ${getErrorMessage(err)}. ` +
          'Check MINIO_ACCESS_KEY/MINIO_SECRET_KEY or create buckets manually.',
      );
      return;
    }

    for (const bucket of BUCKETS) {
      try {
        const exists = await this.client.bucketExists(bucket);
        if (!exists) {
          await this.client.makeBucket(bucket, 'us-east-1');
          this.logger.log(`Created MinIO bucket: ${bucket}`);
        }
      } catch (err) {
        this.logger.warn(`Skipping MinIO bucket ${bucket}: ${getErrorMessage(err)}`);
      }
    }
  }

  async ensureBucket(name: string): Promise<void> {
    const exists = await this.client.bucketExists(name);
    if (!exists) {
      await this.client.makeBucket(name, 'us-east-1');
      this.logger.log(`Created MinIO bucket: ${name}`);
    }
  }

  async uploadFile(
    bucket: string,
    key: string,
    buffer: Buffer,
    size: number,
    contentType: string,
  ): Promise<void> {
    const readable = Readable.from(buffer);
    await this.client.putObject(bucket, key, readable, size, {
      'Content-Type': contentType,
    });
  }

  async downloadFile(bucket: string, key: string): Promise<Buffer> {
    const stream = await this.client.getObject(bucket, key);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async deleteFile(bucket: string, key: string): Promise<void> {
    await this.client.removeObject(bucket, key);
  }

  /**
   * Best-effort delete of a single object — never throws (used during cascade
   * cleanup where a missing object should not abort the whole deletion).
   */
  async tryDeleteFile(bucket: string, key: string): Promise<void> {
    try {
      await this.client.removeObject(bucket, key);
    } catch (err) {
      this.logger.warn(
        `Failed to delete ${bucket}/${key}: ${getErrorMessage(err)}`,
      );
    }
  }

  /**
   * Remove every object in a bucket and then the bucket itself. Used to drop a
   * document's per-document page-image bucket (bucket name = document UUID).
   * Best-effort: logs and returns on error.
   */
  async removeBucketRecursive(bucket: string): Promise<void> {
    try {
      const exists = await this.client.bucketExists(bucket);
      if (!exists) return;

      const names: string[] = await new Promise((resolve, reject) => {
        const acc: string[] = [];
        const stream = this.client.listObjectsV2(bucket, '', true);
        stream.on('data', (obj) => {
          if (obj.name) acc.push(obj.name);
        });
        stream.on('end', () => resolve(acc));
        stream.on('error', reject);
      });

      if (names.length > 0) {
        await this.client.removeObjects(bucket, names);
      }
      await this.client.removeBucket(bucket);
    } catch (err) {
      this.logger.warn(
        `Failed to remove bucket ${bucket}: ${getErrorMessage(err)}`,
      );
    }
  }

  async getPresignedUrl(
    bucket: string,
    key: string,
    expiry: number = 3600,
  ): Promise<string> {
    return this.presignClient.presignedGetObject(bucket, key, expiry);
  }

  getClient(): Minio.Client {
    return this.client;
  }
}
