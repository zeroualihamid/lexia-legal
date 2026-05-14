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
];

const getErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

@Injectable()
export class MinioService implements OnModuleInit {
  private client: Minio.Client;
  private readonly logger = new Logger(MinioService.name);

  constructor(private configService: ConfigService) {
    this.client = new Minio.Client({
      endPoint: this.configService.get<string>('minio.endPoint'),
      port: this.configService.get<number>('minio.port'),
      useSSL: this.configService.get<boolean>('minio.useSSL'),
      accessKey: this.configService.get<string>('minio.accessKey'),
      secretKey: this.configService.get<string>('minio.secretKey'),
    });
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

  async getPresignedUrl(
    bucket: string,
    key: string,
    expiry: number = 3600,
  ): Promise<string> {
    return this.client.presignedGetObject(bucket, key, expiry);
  }

  getClient(): Minio.Client {
    return this.client;
  }
}
