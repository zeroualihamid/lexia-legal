import { Module } from '@nestjs/common';
import { LegalAuthController } from './legal-auth.controller';

@Module({
  controllers: [LegalAuthController],
})
export class LegalAuthModule {}
