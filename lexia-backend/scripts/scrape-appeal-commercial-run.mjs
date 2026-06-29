/**
 * Scrape 10 commercial appeal judgments from mahakim.ma and ingest into Postgres + MinIO.
 * Run inside backend container: cd /app && node scripts/scrape-appeal-commercial-run.mjs
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { MahakimAppealScraper } from '../dist/modules/scraper/mahakim-appeal.scraper.js';
import { MinioService } from '../dist/modules/storage/minio.service.js';
import { PostgresService } from '../dist/database/postgres.service.js';
import { v4 as uuidv4 } from 'uuid';

const SOURCE_ID = process.env.SCRAPE_SOURCE_ID || 'mahakim-appeal-commercial-batch';
const COLLECTION = 'judgments_commercial';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const scraper = app.get(MahakimAppealScraper);
  const minio = app.get(MinioService);
  const pg = app.get(PostgresService);

  console.log('Starting mahakim commercial appeal scrape (max 10)...');

  const pages = await scraper.scrape({
    maxDownloads: 10,
    fileYears: [2018, 2019, 2020, 2021, 2022],
    fileNumberStart: 4700,
    fileNumberEnd: 5200,
  });

  console.log(`Found ${pages.length} dossier(s)`);

  for (const page of pages) {
    const docId = uuidv4();
    const bucket = 'scraped-html';
    const key = `mahakim-appeal/${SOURCE_ID}/${docId}.txt`;
    const buf = Buffer.from(page.content, 'utf-8');

    await minio.uploadFile(bucket, key, buf, buf.length, 'text/plain');
    await pg.query(
      `INSERT INTO documents
         (id, title_ar, collection, source_type, owner_type, status, visibility,
          minio_bucket, minio_key, file_size_bytes, content_type, metadata, ocr_text)
       VALUES ($1, $2, $3, 'scraping', 'system', 'processing', 'public',
               $4, $5, $6, 'text/plain', $7::jsonb, $8)`,
      [
        docId,
        page.title,
        COLLECTION,
        bucket,
        key,
        buf.length,
        JSON.stringify({
          scraperSourceId: SOURCE_ID,
          scraper: 'mahakim',
          courtLevel: 'appeal',
          ...(page.metadata || {}),
        }),
        page.content.slice(0, 50000),
      ],
    );
    console.log('Ingested:', page.title);
  }

  await app.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
