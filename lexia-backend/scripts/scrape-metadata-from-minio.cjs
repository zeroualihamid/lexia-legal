/**
 * OCR + judgment metadata on a scraped PDF in MinIO.
 * Usage: node scripts/scrape-metadata-from-minio.mjs <minio-key>
 */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { MinioService } = require('../dist/modules/storage/minio.service');
const { MistralOcrService } = require('../dist/modules/ocr/mistral-ocr.service');
const { JudgmentMetadataService } = require('../dist/modules/documents/judgment-metadata.service');

async function main() {
  const key =
    process.argv[2] ||
    'scrapers/10f61752-cb72-4d91-93fa-f12f9b4cc42c/9e61bab1-b988-465b-8453-279c9f3d343a/ملف2023_1_1_1823—قرار2024_104—2024-02-13.pdf';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const minio = app.get(MinioService);
    const ocr = app.get(MistralOcrService);
    const meta = app.get(JudgmentMetadataService);

    const pdf = await minio.downloadFile('raw-pdfs', key);
    console.log('pdf bytes', pdf.length);
    const text = await ocr.processPdf(pdf);
    console.log('ocr chars', text.length);
    const judgment = await meta.extractFromText(text);
    console.log(JSON.stringify(judgment, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
