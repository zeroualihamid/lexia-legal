import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { DocumentProcessor } from './document.processor';
import { ScrapingProcessor } from './scraping.processor';
import { CorpusSchedulerService } from './corpus-scheduler.service';
import { ChatModule } from '../chat/chat.module';
import { OcrModule } from '../ocr/ocr.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentsModule } from '../documents/documents.module';
import { AgentDocsModule } from '../agent-docs/agent-docs.module';
import { ScraperModule } from '../scraper/scraper.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'document-processing', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } },
      { name: 'scraping', defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 30_000 }, timeout: 1_200_000 }, settings: { lockDuration: 1_200_000, stalledInterval: 120_000, maxStalledCount: 2 } },
      { name: 'embedding', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 3000 } } },
      // LLM runs are non-idempotent and bill against the user's Claude
      // subscription — never auto-retry on failure.
      { name: 'judgment-analysis', defaultJobOptions: { attempts: 1, removeOnComplete: 50, removeOnFail: 50 } },
    ),
    ChatModule,
    OcrModule,
    StorageModule,
    DocumentsModule,
    AgentDocsModule,
    ScraperModule,
  ],
  providers: [DocumentProcessor, ScrapingProcessor, CorpusSchedulerService],
  exports: [BullModule, CorpusSchedulerService],
})
export class QueueModule {}
