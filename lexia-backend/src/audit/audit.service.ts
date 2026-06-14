import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";

/**
 * Scheduled conversation-quality audit (BullMQ cron).
 *
 * On a cron schedule, this fires a job whose worker calls the agent's
 * `POST /admin/claude/audit`: the agent grades each recent conversation's
 * response with a cheap LLM pass and — when auto-fix is enabled — runs the
 * Claude Code judge to correct the faulty CTE (and, where it helps, the
 * SKILL.md routing). BullMQ gives us scheduling, single-flight concurrency,
 * retries and persistence; the heavy AI work stays in the agent.
 *
 * The whole subsystem is OFF unless `LEXIA_AUDIT_ENABLED=true` AND a Redis
 * connection is reachable, so existing deployments without Redis are unaffected.
 */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private readonly queueName = "lexia-conversation-audit";
  private queue?: Queue;
  private worker?: Worker;

  private readonly enabled =
    (process.env.LEXIA_AUDIT_ENABLED ?? "false").toLowerCase() === "true";
  private readonly redisUrl = process.env.REDIS_URL ?? "";
  // Default: every 6 hours, on the hour (standard 5-field cron).
  private readonly cron = process.env.LEXIA_AUDIT_CRON ?? "0 */6 * * *";
  private readonly agentUrl =
    process.env.LEXIA_AGENT_URL ?? "http://localhost:8000";
  private readonly httpTimeoutMs = Number(
    process.env.LEXIA_AUDIT_HTTP_TIMEOUT_MS ?? 1_500_000, // 25 min (auto-fix is slow)
  );

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log("Conversation audit disabled (LEXIA_AUDIT_ENABLED!=true).");
      return;
    }
    if (!this.redisUrl) {
      this.logger.warn(
        "LEXIA_AUDIT_ENABLED=true but REDIS_URL is unset — audit cron NOT started.",
      );
      return;
    }

    let connection: ConnectionOptions;
    try {
      connection = this.parseRedisUrl(this.redisUrl);
    } catch (e) {
      this.logger.error(
        `Invalid REDIS_URL — audit cron NOT started: ${e instanceof Error ? e.message : e}`,
      );
      return;
    }

    try {
      // Pass a connection-OPTIONS object (not an ioredis instance): BullMQ owns
      // the connection and applies the worker-required maxRetriesPerRequest:null
      // itself, and closing the queue/worker closes the sockets.
      this.queue = new Queue(this.queueName, { connection });

      this.worker = new Worker(
        this.queueName,
        async (job: Job) => this.runAudit(job),
        { connection, concurrency: 1 },
      );
      this.worker.on("failed", (job, err) =>
        this.logger.error(`Audit job ${job?.id} failed: ${err?.message ?? err}`),
      );
      this.worker.on("completed", (job) =>
        this.logger.log(`Audit job ${job.id} completed.`),
      );
      this.worker.on("error", (err) =>
        this.logger.warn(`Audit worker error: ${err?.message ?? err}`),
      );

      // Atomic create-or-update of the recurring schedule (BullMQ v5 Job
      // Scheduler API — replaces the deprecated `repeat` option).
      await this.queue.upsertJobScheduler(
        "conversation-audit-cron",
        { pattern: this.cron },
        { name: "audit", data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      );
      this.logger.log(
        `Conversation audit cron scheduled (pattern="${this.cron}", agent=${this.agentUrl}).`,
      );

      if ((process.env.LEXIA_AUDIT_RUN_ON_BOOT ?? "false").toLowerCase() === "true") {
        await this.queue.add("audit", { trigger: "boot" });
        this.logger.log("Queued an immediate audit run (LEXIA_AUDIT_RUN_ON_BOOT=true).");
      }
    } catch (e) {
      this.logger.error(
        `Failed to start audit cron: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Parse a redis[s]://[user:pass@]host:port[/db] URL into BullMQ options. */
  private parseRedisUrl(raw: string): ConnectionOptions {
    const u = new URL(raw);
    const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : 0;
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 6379,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      ...(Number.isFinite(db) ? { db } : {}),
      ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    };
  }

  /** The audit parameters sent to the agent, read fresh from env each run. */
  private auditPayload(): Record<string, unknown> {
    return {
      limit: Number(process.env.LEXIA_AUDIT_LIMIT ?? 50),
      max_eval: Number(process.env.LEXIA_AUDIT_MAX_EVAL ?? 30),
      since_seconds: Number(process.env.LEXIA_AUDIT_SINCE_SECONDS ?? 0),
      min_severity: process.env.LEXIA_AUDIT_MIN_SEVERITY ?? "medium",
      auto_fix:
        (process.env.LEXIA_AUDIT_AUTO_FIX ?? "false").toLowerCase() === "true",
      max_fixes: Number(process.env.LEXIA_AUDIT_MAX_FIXES ?? 3),
      fix_timeout: Number(process.env.LEXIA_AUDIT_FIX_TIMEOUT ?? 900),
    };
  }

  /** Worker processor: call the agent audit endpoint and log the report. */
  private async runAudit(job: Job): Promise<Record<string, unknown>> {
    const payload = this.auditPayload();
    this.logger.log(
      `Running conversation audit (job ${job.id}, auto_fix=${payload.auto_fix}).`,
    );
    const res = await fetch(`${this.agentUrl}/admin/claude/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.httpTimeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`agent /admin/claude/audit ${res.status}: ${body.slice(0, 500)}`);
    }
    const report = (await res.json()) as Record<string, unknown>;
    this.logger.log(
      `Audit report: scanned=${report.audited} flagged=${report.flagged_count} ` +
        `fixed=${Array.isArray(report.fixed) ? report.fixed.length : 0}`,
    );
    return report;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }
}
