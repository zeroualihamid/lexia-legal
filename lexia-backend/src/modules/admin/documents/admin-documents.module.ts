import { Module } from '@nestjs/common';
import { AdminDocumentsController } from './admin-documents.controller';
import { DocumentsModule } from '../../documents/documents.module';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [DocumentsModule, StorageModule],
  controllers: [AdminDocumentsController],
})
export class AdminDocumentsModule {}
