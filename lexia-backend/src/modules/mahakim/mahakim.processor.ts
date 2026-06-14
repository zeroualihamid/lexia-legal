import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PostgresService } from '../../database/postgres.service';
import { MahakimService } from './mahakim.service';
import { MahakimSyncJob } from './mahakim.types';

@Processor('mahakim-sync')
export class MahakimProcessor {
  private readonly logger = new Logger(MahakimProcessor.name);

  constructor(
    private readonly mahakim: MahakimService,
    private readonly postgres: PostgresService,
  ) {}

  @Process({ name: 'sync', concurrency: 1 })
  async sync(job: Job<MahakimSyncJob>): Promise<void> {
    const { caseId, query } = job.data;
    this.logger.log(
      `mahakim sync for case ${caseId}: ${query.courtName} ${query.fileCode}/${query.fileYear}`,
    );

    // Guard against stale jobs: if the case reference changed since this job was
    // enqueued (e.g. the lawyer typed a new court file in chat), skip it so we
    // don't clobber a newer status with an outdated result.
    if (!(await this.refStillMatches(caseId, query))) {
      this.logger.warn(
        `mahakim sync skipped for case ${caseId}: reference changed since enqueue`,
      );
      return;
    }

    // Mark processing (only if the case still exists).
    await this.postgres.query(
      `UPDATE cases SET mahakim_status = 'processing', mahakim_error = NULL WHERE id = $1`,
      [caseId],
    );

    try {
      const result = await this.mahakim.fetchCase(query);
      const status = result.found ? 'ready' : 'not_found';
      // Re-check after the (slow) scrape — the reference may have changed while
      // the headless browser was running.
      if (!(await this.refStillMatches(caseId, query))) {
        this.logger.warn(
          `mahakim sync result dropped for case ${caseId}: reference changed during fetch`,
        );
        return;
      }
      await this.postgres.query(
        `UPDATE cases
           SET mahakim_status = $1,
               mahakim_data = $2,
               mahakim_error = $3,
               mahakim_fetched_at = NOW()
         WHERE id = $4`,
        [
          status,
          JSON.stringify(result),
          result.found ? null : result.message,
          caseId,
        ],
      );
      this.logger.log(
        `mahakim sync done for case ${caseId}: ${status} (${result.tables.length} tables)`,
      );
    } catch (err: any) {
      this.logger.error(
        `mahakim sync failed for case ${caseId}: ${err?.message}`,
        err?.stack,
      );
      if (await this.refStillMatches(caseId, query)) {
        await this.postgres.query(
          `UPDATE cases SET mahakim_status = 'failed', mahakim_error = $1 WHERE id = $2`,
          [String(err?.message || err).slice(0, 500), caseId],
        );
      }
      throw err;
    }
  }

  /** True when the case's current tracking reference still equals the job's. */
  private async refStillMatches(
    caseId: string,
    query: MahakimSyncJob['query'],
  ): Promise<boolean> {
    const row = await this.postgres.queryOne<any>(
      `SELECT court_type, court_name, file_number, file_code, file_year, case_category
         FROM cases WHERE id = $1`,
      [caseId],
    );
    if (!row) return false;
    const norm = (v?: string | null) => (v || '').replace(/\s+/g, '').trim();
    return (
      norm(row.court_name) === norm(query.courtName) &&
      norm(row.file_number) === norm(query.fileNumber) &&
      norm(row.file_code) === norm(query.fileCode) &&
      norm(row.file_year) === norm(query.fileYear)
    );
  }
}
