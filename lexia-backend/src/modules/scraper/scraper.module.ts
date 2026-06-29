import { Module, Global } from '@nestjs/common';
import { SggScraper } from './sgg.scraper';
import { AdalaScraper } from './adala.scraper';
import { JuriscassationScraper } from './juriscassation.scraper';
import { ScraperFactoryService } from './scraper-factory.service';
import { FileReferenceScraperService } from './file-reference-scraper.service';
import { MahakimAppealScraper } from './mahakim-appeal.scraper';
import { MahakimModule } from '../mahakim/mahakim.module';

@Global()
@Module({
  imports: [MahakimModule],
  providers: [
    SggScraper,
    AdalaScraper,
    JuriscassationScraper,
    ScraperFactoryService,
    FileReferenceScraperService,
    MahakimAppealScraper,
  ],
  exports: [
    SggScraper,
    AdalaScraper,
    JuriscassationScraper,
    ScraperFactoryService,
    FileReferenceScraperService,
    MahakimAppealScraper,
  ],
})
export class ScraperModule {}
