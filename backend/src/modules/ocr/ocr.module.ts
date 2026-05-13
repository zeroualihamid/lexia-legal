import { Module, Global } from '@nestjs/common';
import { MistralOcrService } from './mistral-ocr.service';

@Global()
@Module({
  providers: [MistralOcrService],
  exports: [MistralOcrService],
})
export class OcrModule {}
