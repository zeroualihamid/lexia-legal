import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { ChatModule } from '../chat/chat.module';
import { ChatUploadsModule } from '../chat-uploads/chat-uploads.module';
import { DocumentsModule } from '../documents/documents.module';

@Module({
  imports: [ChatModule, ChatUploadsModule, DocumentsModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
