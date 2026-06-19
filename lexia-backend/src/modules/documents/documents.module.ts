import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { AutoClassifierService } from './auto-classifier.service';
import { AgentDocsModule } from '../agent-docs/agent-docs.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'document-processing' },
      { name: 'judgment-analysis' },
    ),
    AgentDocsModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, AutoClassifierService],
  exports: [DocumentsService, AutoClassifierService],
})
export class DocumentsModule {}
