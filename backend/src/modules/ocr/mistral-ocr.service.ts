import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class MistralOcrService {
  private readonly logger = new Logger(MistralOcrService.name);
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('mistral.apiKey');
  }

  async processPdf(pdfBuffer: Buffer): Promise<string> {
    const base64 = pdfBuffer.toString('base64');

    const response = await axios.post(
      'https://api.mistral.ai/v1/ocr',
      {
        model: 'mistral-ocr-latest',
        document: {
          type: 'document_url',
          document_url: `data:application/pdf;base64,${base64}`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 300000,
      },
    );

    const pages: any[] = response.data?.pages || [];
    const text = pages.map((p) => p.markdown || '').join('\n\n');
    return text;
  }
}
