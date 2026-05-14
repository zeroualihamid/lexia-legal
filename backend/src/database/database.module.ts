import { Module, Global } from '@nestjs/common';
import { PostgresService } from './postgres.service';
import { QdrantService } from './qdrant.service';
import { RedisPubSubService } from './redis-pubsub.service';

@Global()
@Module({
  providers: [PostgresService, QdrantService, RedisPubSubService],
  exports: [PostgresService, QdrantService, RedisPubSubService],
})
export class DatabaseModule {}
