import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { ChatModule } from './modules/chat/chat.module';
import { SearchModule } from './modules/search/search.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { BillingModule } from './modules/billing/billing.module';
import { AdminModule } from './modules/admin/admin.module';
import { OcrModule } from './modules/ocr/ocr.module';
import { StorageModule } from './modules/storage/storage.module';
import { QueueModule } from './modules/queue/queue.module';
import { ScraperModule } from './modules/scraper/scraper.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const redisConfig: any = {
          host: configService.get<string>('redis.host'),
          port: configService.get<number>('redis.port'),
        };
        const password = configService.get<string>('redis.password');
        if (password) redisConfig.password = password;
        return { redis: redisConfig };
      },
      inject: [ConfigService],
    }),
    DatabaseModule,
    StorageModule,
    OcrModule,
    ChatModule,
    SearchModule,
    DocumentsModule,
    BillingModule,
    AdminModule,
    QueueModule,
    ScraperModule,
    HealthModule,
  ],
})
export class AppModule {}
