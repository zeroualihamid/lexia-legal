import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bull";
import configuration from "./config/configuration";
import { DatabaseModule } from "./database/database.module";
import { ChatModule } from "./modules/chat/chat.module";
import { ChatUploadsModule } from "./modules/chat-uploads/chat-uploads.module";
import { SearchModule } from "./modules/search/search.module";
import { DocumentsModule } from "./modules/documents/documents.module";
import { CasesModule } from "./modules/cases/cases.module";
import { BillingModule } from "./modules/billing/billing.module";
import { AdminModule } from "./modules/admin/admin.module";
import { OcrModule } from "./modules/ocr/ocr.module";
import { StorageModule } from "./modules/storage/storage.module";
import { QueueModule } from "./modules/queue/queue.module";
import { ScraperModule } from "./modules/scraper/scraper.module";
import { HealthModule } from "./health/health.module";
import { AuthGuard } from "./auth/auth.guard";
import { AuditModule } from "./audit/audit.module";
import { AgentChatController } from "./agent-chat/chat.controller";
import { CrossTowerModule } from "./cross-tower/cross-tower.module";
import { TasksModule } from "./modules/tasks/tasks.module";
import { LegalAuthModule } from "./modules/auth/legal-auth.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const redisConfig: Record<string, unknown> = {
          host: configService.get<string>("redis.host"),
          port: configService.get<number>("redis.port"),
        };
        const password = configService.get<string>("redis.password");
        if (password) redisConfig.password = password;
        return { redis: redisConfig };
      },
      inject: [ConfigService],
    }),
    DatabaseModule,
    StorageModule,
    OcrModule,
    ChatModule,
    ChatUploadsModule,
    SearchModule,
    DocumentsModule,
    CasesModule,
    BillingModule,
    AdminModule,
    QueueModule,
    ScraperModule,
    HealthModule,
    AuditModule,
    CrossTowerModule,
    TasksModule,
    LegalAuthModule,
  ],
  controllers: [AgentChatController],
  providers: [AuthGuard],
})
export class AppModule {}
