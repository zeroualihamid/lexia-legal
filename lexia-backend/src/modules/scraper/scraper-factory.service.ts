import { Injectable } from '@nestjs/common';
import { BaseScraper } from './base.scraper';
import { SggScraper } from './sgg.scraper';
import { AdalaScraper } from './adala.scraper';
import { JuriscassationScraper } from './juriscassation.scraper';
import { MahakimAppealScraper } from './mahakim-appeal.scraper';

@Injectable()
export class ScraperFactoryService {
  constructor(
    private sggScraper: SggScraper,
    private adalaScraper: AdalaScraper,
    private juriscassationScraper: JuriscassationScraper,
    private mahakimAppealScraper: MahakimAppealScraper,
  ) {}

  getScraper(scraperType: string): BaseScraper {
    switch (scraperType.toLowerCase()) {
      case 'sgg':
      case 'sgg.gov.ma':
        return this.sggScraper;
      case 'adala':
      case 'adala.justice.gov.ma':
        return this.adalaScraper;
      case 'juriscassation':
      case 'cspj':
      case 'cour_cassation':
      case 'juriscassation.cspj.ma':
        return this.juriscassationScraper;
      case 'mahakim':
      case 'mahakim.ma':
      case 'cour_appel':
      case 'tribunal_appel':
        return this.mahakimAppealScraper;
      default:
        throw new Error(`Unknown scraper type: ${scraperType}`);
    }
  }
}
