import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ChatUploadsController } from './chat-uploads.controller';
import { ChatUploadsService } from './chat-uploads.service';
import { CasesModule } from '../cases/cases.module';
import { AgentDocsModule } from '../agent-docs/agent-docs.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'document-processing' }),
    CasesModule,
    AgentDocsModule,
  ],
  controllers: [ChatUploadsController],
  providers: [ChatUploadsService],
  exports: [ChatUploadsService],
})
export class ChatUploadsModule {}
