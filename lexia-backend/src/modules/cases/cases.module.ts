import { Module } from '@nestjs/common';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';
import { DocumentsModule } from '../documents/documents.module';
import { ChatModule } from '../chat/chat.module';
import { AgentDocsModule } from '../agent-docs/agent-docs.module';
import { MahakimModule } from '../mahakim/mahakim.module';

@Module({
  imports: [DocumentsModule, ChatModule, AgentDocsModule, MahakimModule],
  controllers: [CasesController],
  providers: [CasesService],
  exports: [CasesService],
})
export class CasesModule {}
