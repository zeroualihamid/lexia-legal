import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MistralOcrService {
  private readonly logger = new Logger(MistralOcrService.name);
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('mistral.apiKey');
  }

  /**
   * Extract text from a PDF. Uses Mistral OCR when an API key is configured
   * (best for scanned/image PDFs). Falls back to local `pdftotext` (poppler) —
   * which is bundled in the container for page rendering — when no key is set
   * or the OCR call fails. For digitally-generated (text-based) PDFs the local
   * extraction is exact and needs no external service.
   */
  async processPdf(pdfBuffer: Buffer): Promise<string> {
    if (this.apiKey) {
      try {
        return await this.mistralOcr(pdfBuffer);
      } catch (err: any) {
        this.logger.warn(
          `Mistral OCR failed (${err?.message}); falling back to pdftotext`,
        );
      }
    } else {
      this.logger.log('No Mistral API key set; using local pdftotext extraction');
    }

    return this.pdftotext(pdfBuffer);
  }

  private async mistralOcr(pdfBuffer: Buffer): Promise<string> {
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
    if (!text.trim()) throw new Error('Mistral OCR returned empty text');
    return text;
  }

  /** Local text extraction via poppler's pdftotext, reading from a temp file. */
  private async pdftotext(pdfBuffer: Buffer): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), 'pdftotext');
    await fs.mkdir(tmpDir, { recursive: true });
    const pdfPath = path.join(tmpDir, `${uuidv4()}.pdf`);
    await fs.writeFile(pdfPath, pdfBuffer);

    try {
      const text = await new Promise<string>((resolve, reject) => {
        // `-layout` keeps reading order; `-` writes to stdout.
        const child = spawn('pdftotext', ['-layout', pdfPath, '-']);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
        child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
        child.on('error', (err) =>
          reject(new Error(`pdftotext spawn failed: ${err.message}`)),
        );
        child.on('exit', (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`pdftotext exited ${code}: ${stderr.trim()}`));
        });
      });
      return text;
    } finally {
      await fs.rm(pdfPath, { force: true }).catch(() => {});
    }
  }
}
