import { Module, Global } from '@nestjs/common';
import { PostgresService } from './postgres.service';
import { QdrantService } from './qdrant.service';

@Global()
@Module({
  providers: [PostgresService, QdrantService],
  exports: [PostgresService, QdrantService],
})
export class DatabaseModule {}
