import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PostgresService } from '../../database/postgres.service';

/** 20 min — enough for batch_downloads up to ~100 on CSPJ. */
export const CORPUS_JOB_OPTS = {
  timeout: 1_200_000,
  removeOnComplete: 20,
  removeOnFail: 10,
};

export function corpusJobId(sourceId: string): string {
  return `corpus-batch-${sourceId}`;
}

/** Chained batch while the main job id is still active. */
export function corpusFollowupJobId(sourceId: string): string {
  return `corpus-batch-${sourceId}-next`;
}

@Injectable()
export class CorpusSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(CorpusSchedulerService.name);

  constructor(
    @InjectQueue('scraping') private readonly scrapingQueue: Queue,
    private readonly postgresService: PostgresService,
  ) {}

  onModuleInit(): void {
    const resume = () => {
      this.resumeIncompleteCorpora().catch((err) => {
        this.logger.error(
          `Corpus auto-resume failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    };
    setTimeout(resume, 8_000);
    // Catch chains that break after a batch completes without queuing the next one.
    setInterval(resume, 5 * 60 * 1000);
  }

  async scheduleCorpusBatch(
    sourceId: string,
    data: Record<string, unknown>,
    delayMs = 3_000,
  ): Promise<void> {
    const mainId = corpusJobId(sourceId);
    const followupId = corpusFollowupJobId(sourceId);

    for (const jobId of [mainId, followupId]) {
      const existing = await this.scrapingQueue.getJob(jobId);
      if (!existing) continue;
      const state = await existing.getState();
      if (state === 'waiting' || state === 'delayed') {
        this.logger.log(`Corpus batch already queued for ${sourceId} (${state})`);
        return;
      }
    }

    const main = await this.scrapingQueue.getJob(mainId);
    const mainState = main ? await main.getState() : null;

    // Called from the batch that is still marked active — queue a follow-up slot.
    if (mainState === 'active') {
      const followup = await this.scrapingQueue.getJob(followupId);
      if (followup) {
        const followupState = await followup.getState();
        if (followupState === 'waiting' || followupState === 'delayed') {
          return;
        }
        await followup.remove().catch(() => undefined);
      }
      await this.scrapingQueue.add('scrape-corpus-batch', data, {
        ...CORPUS_JOB_OPTS,
        delay: delayMs,
        jobId: followupId,
      });
      this.logger.log(`Corpus follow-up batch scheduled for ${sourceId} in ${delayMs}ms`);
      return;
    }

    if (main) {
      await main.remove().catch(() => undefined);
    }
    const followup = await this.scrapingQueue.getJob(followupId);
    if (followup) {
      const followupState = await followup.getState();
      if (followupState !== 'active') {
        await followup.remove().catch(() => undefined);
      }
    }

    await this.scrapingQueue.add('scrape-corpus-batch', data, {
      ...CORPUS_JOB_OPTS,
      delay: delayMs,
      jobId: mainId,
    });
  }

  async isCorpusJobPending(sourceId: string): Promise<boolean> {
    for (const jobId of [corpusJobId(sourceId), corpusFollowupJobId(sourceId)]) {
      const job = await this.scrapingQueue.getJob(jobId);
      if (!job) continue;
      const state = await job.getState();
      if (state === 'waiting' || state === 'delayed' || state === 'active') {
        return true;
      }
    }
    return false;
  }

  async resumeIncompleteCorpora(): Promise<number> {
    const rows = await this.postgresService.query<any>(
      `SELECT id, url, scraper_type, collection, config
       FROM sources
       WHERE is_active = true
         AND (config->>'corpus_target') IS NOT NULL
         AND COALESCE((config->>'corpus_downloaded')::int, 0)
           < COALESCE((config->>'corpus_target')::int, 0)`,
    );

    let resumed = 0;
    for (const source of rows) {
      if (await this.isCorpusJobPending(source.id)) continue;
      const cfg = source.config || {};
      await this.scheduleCorpusBatch(
        source.id,
        {
          sourceId: source.id,
          url: source.url,
          scraperType: source.scraper_type,
          collection: source.collection,
          locale: cfg.locale || 'ar',
        },
        2_000,
      );
      resumed += 1;
      this.logger.log(`Corpus auto-resume queued for source ${source.id}`);
    }
    return resumed;
  }

  async resumeCorpusSource(sourceId: string): Promise<{ queued: boolean; message: string }> {
    const source = await this.postgresService.queryOne<any>(
      `SELECT * FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (!source) {
      return { queued: false, message: 'Source not found' };
    }

    const cfg = source.config || {};
    const target = Number(cfg.corpus_target || 0);
    const downloaded = Number(cfg.corpus_downloaded ?? 0);

    if (!target) {
      return { queued: false, message: 'Source is not a corpus job' };
    }
    if (downloaded >= target) {
      return { queued: false, message: 'Corpus already complete' };
    }
    if (await this.isCorpusJobPending(sourceId)) {
      return { queued: false, message: 'Corpus batch already queued or running' };
    }

    await this.scheduleCorpusBatch(
      sourceId,
      {
        sourceId,
        url: source.url,
        scraperType: source.scraper_type,
        collection: source.collection,
        locale: cfg.locale || 'ar',
      },
      1_000,
    );

    return { queued: true, message: 'Corpus batch queued' };
  }
}
