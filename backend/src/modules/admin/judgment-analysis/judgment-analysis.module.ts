import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { JudgmentAnalysisController } from './judgment-analysis.controller';
import { JudgmentAnalysisService } from './judgment-analysis.service';
import { JudgmentAnalysisProcessor } from './judgment-analysis.processor';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'judgment-analysis' }),
    StorageModule,
  ],
  controllers: [JudgmentAnalysisController],
  providers: [JudgmentAnalysisService, JudgmentAnalysisProcessor],
})
export class JudgmentAnalysisModule {}
