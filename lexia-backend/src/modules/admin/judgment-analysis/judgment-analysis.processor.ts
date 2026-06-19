import { Processor, Process } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bull';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import OpenAI from 'openai';
import { MinioService } from '../../storage/minio.service';
import { PostgresService } from '../../../database/postgres.service';
import { RedisPubSubService } from '../../../database/redis-pubsub.service';
import { MistralOcrService } from '../../ocr/mistral-ocr.service';
import { judgmentPromptForText } from './prompts';

export const ANALYSIS_CHANNEL = (id: string) => `judgment-analysis:${id}`;
const FLUSH_INTERVAL_MS = 500;
const FRENCH_RESULT_HEADING = 'Analyse juridique structurée - Version française';
const ARABIC_RESULT_HEADING = 'التحليل القانوني المنظم - النسخة العربية';
const ARABIC_TEXT_PATTERN = /[\u0600-\u06FF]/;

@Processor('judgment-analysis')
export class JudgmentAnalysisProcessor implements OnModuleInit {
  private readonly logger = new Logger(JudgmentAnalysisProcessor.name);

  constructor(
    private minio: MinioService,
    private postgres: PostgresService,
    private pubsub: RedisPubSubService,
    private config: ConfigService,
    private ocr: MistralOcrService,
  ) {}

  async onModuleInit(): Promise<void> {
    const timeoutMs = this.getClaudeTimeoutMs();
    const staleAfterMs = timeoutMs + 60_000;
    try {
      const recovered = await this.postgres.query<{ id: string }>(
        `UPDATE judgment_analyses
           SET status = 'failed',
               error_message = 'Analyse interrompue avant son achèvement',
               completed_at = NOW()
         WHERE status = 'running'
           AND started_at < NOW() - ($1 * INTERVAL '1 millisecond')
         RETURNING id`,
        [staleAfterMs],
      );
      if (recovered.length > 0) {
        this.logger.warn(
          `Marked ${recovered.length} stale judgment analysis job(s) as failed`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Unable to recover stale judgment analyses: ${err.message}`,
      );
    }
  }

  @Process('analyze')
  async analyze(job: Job<{ analysisId: string; bucket: string; key: string }>): Promise<void> {
    const { analysisId, bucket, key } = job.data;
    const channel = ANALYSIS_CHANNEL(analysisId);
    const tmpDir = path.join(os.tmpdir(), 'judgments', analysisId);

    try {
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.mkdir(path.join(tmpDir, '.home'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

      const pdfBuffer = await this.minio.downloadFile(bucket, key);

      await this.postgres.query(
        `UPDATE judgment_analyses
         SET status = 'running',
             started_at = NOW(),
             completed_at = NULL,
             error_message = NULL,
             markdown_result = NULL
         WHERE id = $1`,
        [analysisId],
      );
      await this.pubsub.publish(channel, { type: 'status', status: 'running' });

      // OCR once and reuse the same text for Claude and the fallback provider.
      // This avoids an interactive Claude Read tool call against the binary PDF.
      const ocrText = await this.ocr.processPdf(pdfBuffer);

      let buffer: string;
      try {
        buffer = await this.runClaude(
          analysisId,
          channel,
          tmpDir,
          ocrText,
          job,
        );
        this.assertBilingualResult(buffer);
      } catch (claudeErr: any) {
        this.logger.warn(
          `Claude CLI unavailable (${claudeErr.message}); falling back to DeepSeek for ${analysisId}`,
        );
        await this.pubsub.publish(channel, {
          type: 'chunk',
          content: '',
        });
        buffer = await this.runDeepSeek(analysisId, channel, ocrText, job);
        this.assertBilingualResult(buffer);
      }

      await this.postgres.query(
        `UPDATE judgment_analyses
           SET status = 'completed',
               markdown_result = $2,
               error_message = NULL,
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
    ocrText: string,
    job: Job,
  ): Promise<string> {
    const oauthToken = this.config.get<string>('claude.oauthToken');
    const timeoutMs = this.getClaudeTimeoutMs();
    const killGraceMs =
      this.config.get<number>('claude.killGraceMs') || 5_000;

    return new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      if (oauthToken) {
        env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
        env.ANTHROPIC_AUTH_TOKEN = oauthToken;
      }
      // Do not share /root/.claude.json between concurrent host/container
      // processes. OAuth is provided explicitly, so each run can use an
      // isolated disposable config directory.
      env.HOME = path.join(cwd, '.home');
      env.CLAUDE_CONFIG_DIR = path.join(cwd, '.claude');

      const args = [
        '--print',
        '--permission-mode',
        'dontAsk',
        '--tools',
        '',
        '--no-session-persistence',
      ];
      this.logger.log(
        `spawn: claude --print <OCR text> (timeout=${timeoutMs}ms)`,
      );

      const child = spawn('claude', args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let lastFlush = Date.now();
      let flushPending: Promise<void> = Promise.resolve();
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const clearTimers = () => {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };

      const killChild = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== 'win32') {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          /* process already exited */
        }
      };

      const fail = (error: Error, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (terminate) {
          killChild('SIGTERM');
          forceKillTimer = setTimeout(() => killChild('SIGKILL'), killGraceMs);
        }
        reject(error);
      };

      const timeout = setTimeout(() => {
        fail(
          new Error(
            `La CLI claude a dépassé le délai maximal de ${Math.ceil(timeoutMs / 60_000)} minutes`,
          ),
          true,
        );
      }, timeoutMs);

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
        fail(new Error(`Échec du lancement de la CLI claude: ${err.message}`));
      });

      child.on('exit', async (code) => {
        if (settled) return;
        settled = true;
        clearTimers();
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

      child.stdin.on('error', (err) => {
        fail(new Error(`Échec d'envoi du texte OCR à Claude: ${err.message}`), true);
      });
      child.stdin.end(judgmentPromptForText(ocrText));
    });
  }

  /**
   * Fallback summariser using an OpenAI-compatible chat model (DeepSeek). Used
   * when the Claude CLI is not available/authenticated in the runtime. Streams
   * the bilingual analysis from the OCR text over the same pubsub channel.
   */
  private async runDeepSeek(
    analysisId: string,
    channel: string,
    ocrText: string,
    job: Job,
  ): Promise<string> {
    const apiKey = this.config.get<string>('llm.apiKey');
    const baseURL = this.config.get<string>('llm.baseURL');
    const model = this.config.get<string>('llm.chatModel') || 'deepseek-chat';
    if (!apiKey || !baseURL) {
      throw new Error(
        'Aucun fournisseur de secours configuré (LLM_BASE_URL / DEEPSEEK_API_KEY manquants)',
      );
    }

    const client = new OpenAI({ apiKey, baseURL });
    const stream = await client.chat.completions.create({
      model,
      stream: true,
      temperature: 0.2,
      max_tokens: 8000,
      messages: [{ role: 'user', content: judgmentPromptForText(ocrText) }],
    });

    let buffer = '';
    let lastFlush = Date.now();
    const flush = async () => {
      try {
        await this.postgres.query(
          `UPDATE judgment_analyses SET markdown_result = $2 WHERE id = $1`,
          [analysisId, buffer],
        );
      } catch (err: any) {
        this.logger.warn(`DB flush failed for ${analysisId}: ${err.message}`);
      }
    };

    for await (const part of stream) {
      const text = part.choices[0]?.delta?.content || '';
      if (!text) continue;
      buffer += text;
      this.pubsub
        .publish(channel, { type: 'chunk', content: text })
        .catch((err) => this.logger.warn(`pubsub publish failed: ${err.message}`));
      if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
        lastFlush = Date.now();
        await flush();
      }
      job.progress(Math.min(95, Math.floor(buffer.length / 80))).catch(() => undefined);
    }

    await flush();
    return buffer;
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

  private getClaudeTimeoutMs(): number {
    return this.config.get<number>('claude.analysisTimeoutMs') || 10 * 60 * 1000;
  }
}
