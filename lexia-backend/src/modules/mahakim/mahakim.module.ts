import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MahakimService } from './mahakim.service';
import { MahakimProcessor } from './mahakim.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'mahakim-sync',
      // Headless-browser scrapes are best-effort; retry twice with backoff.
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 15000 },
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    }),
  ],
  providers: [MahakimService, MahakimProcessor],
  exports: [MahakimService, BullModule],
})
export class MahakimModule {}
