import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PlatformHealthController } from './platform-health.controller';

@Module({
  controllers: [HealthController, PlatformHealthController],
})
export class HealthModule {}
