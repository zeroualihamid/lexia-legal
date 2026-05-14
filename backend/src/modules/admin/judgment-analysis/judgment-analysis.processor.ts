import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MinioService } from '../../storage/minio.service';
import { PostgresService } from '../../../database/postgres.service';
import { RedisPubSubService } from '../../../database/redis-pubsub.service';
import { JUDGMENT_PROMPT } from './prompts';

export const ANALYSIS_CHANNEL = (id: string) => `judgment-analysis:${id}`;
const FLUSH_INTERVAL_MS = 500;
const FRENCH_RESULT_HEADING = 'Analyse juridique structurée - Version française';
const ARABIC_RESULT_HEADING = 'التحليل القانوني المنظم - النسخة العربية';
const ARABIC_TEXT_PATTERN = /[\u0600-\u06FF]/;

@Processor('judgment-analysis')
export class JudgmentAnalysisProcessor {
  private readonly logger = new Logger(JudgmentAnalysisProcessor.name);

  constructor(
    private minio: MinioService,
    private postgres: PostgresService,
    private pubsub: RedisPubSubService,
  ) {}

  @Process('analyze')
  async analyze(job: Job<{ analysisId: string; bucket: string; key: string }>): Promise<void> {
    const { analysisId, bucket, key } = job.data;
    const channel = ANALYSIS_CHANNEL(analysisId);
    const tmpDir = path.join(os.tmpdir(), 'judgments', analysisId);

    try {
      await fs.mkdir(tmpDir, { recursive: true });

      const pdfBuffer = await this.minio.downloadFile(bucket, key);
      const pdfPath = path.join(tmpDir, 'judgment.pdf');
      await fs.writeFile(pdfPath, pdfBuffer);

      await this.postgres.query(
        `UPDATE judgment_analyses SET status = 'running', started_at = NOW() WHERE id = $1`,
        [analysisId],
      );
      await this.pubsub.publish(channel, { type: 'status', status: 'running' });

      const buffer = await this.runClaude(analysisId, channel, tmpDir, job);
      this.assertBilingualResult(buffer);

      await this.postgres.query(
        `UPDATE judgment_analyses
           SET status = 'completed',
               markdown_result = $2,
               completed_at = NOW()
         WHERE id = $1`,
        [analysisId, buffer],
      );
      await this.pubsub.publish(channel, { type: 'done', markdown: buffer });
      await job.progress(100);
      this.logger.log(`Analyse ${analysisId} terminée (${buffer.length} chars)`);
    } catch (err: any) {
      const message = err?.message || String(err);
      this.logger.error(`Analyse ${analysisId} a échoué: ${message}`);
      await this.postgres.query(
        `UPDATE judgment_analyses
           SET status = 'failed',
               error_message = $2,
               completed_at = NOW()
         WHERE id = $1`,
        [analysisId, message],
      );
      await this.pubsub.publish(channel, { type: 'error', message });
      throw err;
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private runClaude(
    analysisId: string,
    channel: string,
    cwd: string,
    job: Job,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Force OAuth path: strip ANTHROPIC_API_KEY so the CLI uses the
      // credentials mounted from the host at /root/.claude.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const args = ['-p', JUDGMENT_PROMPT, '--add-dir', cwd];
      this.logger.log(`spawn: claude ${args.slice(0, 1).join(' ')} <prompt> --add-dir ${cwd}`);

      const child = spawn('claude', args, { cwd, env });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let lastFlush = Date.now();
      let flushPending: Promise<void> = Promise.resolve();

      const flushToDb = async () => {
        const snapshot = stdoutBuffer;
        try {
          await this.postgres.query(
            `UPDATE judgment_analyses SET markdown_result = $2 WHERE id = $1`,
            [analysisId, snapshot],
          );
        } catch (err: any) {
          this.logger.warn(`DB flush failed for ${analysisId}: ${err.message}`);
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdoutBuffer += text;

        // Fire-and-forget pubsub (cheap)
        this.pubsub
          .publish(channel, { type: 'chunk', content: text })
          .catch((err) => this.logger.warn(`pubsub publish failed: ${err.message}`));

        // Throttled DB persistence
        if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
          lastFlush = Date.now();
          flushPending = flushToDb();
        }

        // Coarse progress: cap at 95 until exit
        const pct = Math.min(95, Math.floor(stdoutBuffer.length / 80));
        job.progress(pct).catch(() => undefined);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrBuffer += text;
        this.logger.warn(`[claude:${analysisId}] ${text.trimEnd()}`);
      });

      child.on('error', (err) => {
        reject(new Error(`Échec du lancement de la CLI claude: ${err.message}`));
      });

      child.on('exit', async (code) => {
        await flushPending;
        if (code === 0) {
          // Final flush of complete buffer
          await flushToDb();
          resolve(stdoutBuffer);
        } else {
          const tail = stderrBuffer.trim().split('\n').slice(-5).join('\n');
          reject(new Error(`claude exited ${code}${tail ? ` — ${tail}` : ''}`));
        }
      });
    });
  }

  private assertBilingualResult(markdown: string): void {
    const hasFrenchSection = markdown.includes(FRENCH_RESULT_HEADING);
    const hasArabicSection = markdown.includes(ARABIC_RESULT_HEADING);
    const hasArabicText = ARABIC_TEXT_PATTERN.test(markdown);

    if (!hasFrenchSection || !hasArabicSection || !hasArabicText) {
      throw new Error(
        'La sortie Claude est invalide: le rapport doit contenir une version française complète et une version arabe complète.',
      );
    }
  }
}
