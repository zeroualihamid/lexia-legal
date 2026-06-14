import { Module } from "@nestjs/common";
import { AuditService } from "./audit.service";

/**
 * Conversation-quality audit cron (BullMQ). Self-contained: the service only
 * connects to Redis and starts a worker when LEXIA_AUDIT_ENABLED=true and
 * REDIS_URL is set, so importing this module is a no-op otherwise.
 */
@Module({
  providers: [AuditService],
})
export class AuditModule {}
