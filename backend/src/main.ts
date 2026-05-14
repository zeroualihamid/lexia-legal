import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ExpressAdapter } from '@nestjs/platform-express';
import * as express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter as BullBoardExpressAdapter } from '@bull-board/express';
import * as Queue from 'bull';
import { AppModule } from './app.module';

async function bootstrap() {
  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port');
  const corsOrigin = configService.get<string>('cors.origin');
  const redisHost = configService.get<string>('redis.host');
  const redisPort = configService.get<number>('redis.port');
  const redisPassword = configService.get<string>('redis.password');

  const redisConfig: any = { host: redisHost, port: redisPort };
  if (redisPassword) redisConfig.password = redisPassword;

  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Lexia Legal AI API')
    .setDescription('Moroccan Legal AI Platform API')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Chat', 'AI chat and conversation endpoints')
    .addTag('Search', 'Legal document search endpoints')
    .addTag('Documents', 'Document management endpoints')
    .addTag('Billing', 'Subscription and billing endpoints')
    .addTag('Admin', 'Administrative endpoints')
    .addTag('Health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Bull Board setup
  const documentQueue = new Queue('document-processing', { redis: redisConfig });
  const scrapingQueue = new Queue('scraping', { redis: redisConfig });
  const embeddingQueue = new Queue('embedding', { redis: redisConfig });
  const judgmentAnalysisQueue = new Queue('judgment-analysis', { redis: redisConfig });

  const bullBoardAdapter = new BullBoardExpressAdapter();
  bullBoardAdapter.setBasePath('/bull-board');

  createBullBoard({
    queues: [
      new BullAdapter(documentQueue),
      new BullAdapter(scrapingQueue),
      new BullAdapter(embeddingQueue),
      new BullAdapter(judgmentAnalysisQueue),
    ],
    serverAdapter: bullBoardAdapter,
  });

  server.use('/bull-board', bullBoardAdapter.getRouter());

  await app.listen(port);
  console.log(`Lexia Legal Backend running on port ${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
  console.log(`Bull Board: http://localhost:${port}/bull-board`);
}

bootstrap();
