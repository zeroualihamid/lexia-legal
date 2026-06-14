import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../database/postgres.service';
import { QdrantService } from '../database/qdrant.service';
import { MinioService } from '../modules/storage/minio.service';
import Redis from 'ioredis';

@ApiTags('Health')
@Controller('health')
export class PlatformHealthController {
  private redis: Redis;

  constructor(
    private postgresService: PostgresService,
    private qdrantService: QdrantService,
    private minioService: MinioService,
    private configService: ConfigService,
  ) {
    const redisConfig: any = {
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      lazyConnect: true,
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    };
    const password = this.configService.get<string>('redis.password');
    if (password) redisConfig.password = password;
    this.redis = new Redis(redisConfig);
    this.redis.on('error', () => {
      /* Health check reports Redis as false when unavailable. */
    });
  }

  @Get()
  @ApiOperation({ summary: 'Health check all services' })
  async check() {
    const [postgres, qdrant, minio, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkQdrant(),
      this.checkMinio(),
      this.checkRedis(),
    ]);

    const allHealthy = postgres && qdrant && minio && redis;

    return {
      status: allHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      services: {
        postgres,
        qdrant,
        minio,
        redis,
      },
    };
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.postgresService.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async checkQdrant(): Promise<boolean> {
    try {
      const client = this.qdrantService.getClient();
      await client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  private async checkMinio(): Promise<boolean> {
    try {
      const client = this.minioService.getClient();
      await client.listBuckets();
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
