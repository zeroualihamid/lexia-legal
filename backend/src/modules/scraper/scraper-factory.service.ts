import { Injectable } from '@nestjs/common';
import { BaseScraper } from './base.scraper';
import { SggScraper } from './sgg.scraper';
import { AdalaScraper } from './adala.scraper';

@Injectable()
export class ScraperFactoryService {
  constructor(
    private sggScraper: SggScraper,
    private adalaScraper: AdalaScraper,
  ) {}

  getScraper(scraperType: string): BaseScraper {
    switch (scraperType.toLowerCase()) {
      case 'sgg':
      case 'sgg.gov.ma':
        return this.sggScraper;
      case 'adala':
      case 'adala.justice.gov.ma':
        return this.adalaScraper;
      default:
        throw new Error(`Unknown scraper type: ${scraperType}`);
    }
  }
}
