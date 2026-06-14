import { Module, Global } from '@nestjs/common';
import { SggScraper } from './sgg.scraper';
import { AdalaScraper } from './adala.scraper';
import { ScraperFactoryService } from './scraper-factory.service';

@Global()
@Module({
  providers: [SggScraper, AdalaScraper, ScraperFactoryService],
  exports: [SggScraper, AdalaScraper, ScraperFactoryService],
})
export class ScraperModule {}
