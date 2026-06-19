import { Module } from '@nestjs/common';
import { AdminDocumentsController } from './admin-documents.controller';
import { DocumentsModule } from '../../documents/documents.module';
import { StorageModule } from '../../storage/storage.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [DocumentsModule, StorageModule, UsersModule],
  controllers: [AdminDocumentsController],
})
export class AdminDocumentsModule {}
