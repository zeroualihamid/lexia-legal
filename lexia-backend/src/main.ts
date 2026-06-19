import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { RequestMethod, ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { toNodeHandler } from "better-auth/node";
import express, { type Express } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullAdapter } from "@bull-board/api/bullAdapter";
import { ExpressAdapter as BullBoardExpressAdapter } from "@bull-board/express";
import Queue from "bull";
import { AppModule } from "./app.module";
import { auth, trustedOrigins } from "./auth";
import { createAgentProxy } from "./proxy/agent-proxy";
import { mountMergedOpenApi } from "./docs/merged-openapi";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configService = app.get(ConfigService);
  const port = configService.get<number>("port") ?? Number(process.env.PORT ?? 4000);

  const corsOrigins = new Set([
    ...trustedOrigins,
    configService.get<string>("cors.origin"),
  ].filter(Boolean));

  app.enableCors({
    origin(origin, callback) {
      callback(null, !origin || corsOrigins.has(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Session-ID",
      "X-API-Key",
      "Cache-Control",
      "Accept",
      "ngrok-skip-browser-warning",
      "X-Requested-With",
    ],
    exposedHeaders: ["X-Session-ID"],
    credentials: true,
  });

  app.setGlobalPrefix("api", {
    exclude: [
      { path: "health", method: RequestMethod.GET },
      { path: "chat/stream", method: RequestMethod.POST },
      { path: "docs", method: RequestMethod.ALL },
      { path: "docs-json", method: RequestMethod.ALL },
      { path: "bull-board", method: RequestMethod.ALL },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  const expressApp = app.getHttpAdapter().getInstance() as Express;
  const jsonParser = express.json();

  expressApp.all("/api/auth/*", toNodeHandler(auth));

  expressApp.use((req, res, next) => {
    const p = req.path;
    if (
      p.startsWith("/api/auth") ||
      p === "/api/me" ||
      !p.startsWith("/api/") ||
      req.method === "GET" ||
      req.method === "HEAD" ||
      req.method === "OPTIONS"
    ) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });

  expressApp.use(createAgentProxy());

  const redisHost = configService.get<string>("redis.host");
  const redisPort = configService.get<number>("redis.port");
  const redisPassword = configService.get<string>("redis.password");
  const redisConfig: Record<string, unknown> = { host: redisHost, port: redisPort };
  if (redisPassword) redisConfig.password = redisPassword;

  const documentQueue = new Queue("document-processing", { redis: redisConfig });
  const scrapingQueue = new Queue("scraping", { redis: redisConfig });
  const embeddingQueue = new Queue("embedding", { redis: redisConfig });
  const judgmentAnalysisQueue = new Queue("judgment-analysis", { redis: redisConfig });

  const bullBoardAdapter = new BullBoardExpressAdapter();
  bullBoardAdapter.setBasePath("/bull-board");
  createBullBoard({
    queues: [
      new BullAdapter(documentQueue),
      new BullAdapter(scrapingQueue),
      new BullAdapter(embeddingQueue),
      new BullAdapter(judgmentAnalysisQueue),
    ],
    serverAdapter: bullBoardAdapter,
  });
  expressApp.use("/bull-board", bullBoardAdapter.getRouter());

  const legalSwagger = new DocumentBuilder()
    .setTitle("Lexia Legal AI API")
    .setDescription("Moroccan Legal AI Platform API")
    .setVersion("1.0")
    .addBearerAuth()
    .addTag("Chat", "AI chat and conversation endpoints")
    .addTag("Search", "Legal document search endpoints")
    .addTag("Documents", "Document management endpoints")
    .addTag("Billing", "Subscription and billing endpoints")
    .addTag("Admin", "Administrative endpoints")
    .addTag("Health", "Health check endpoints")
    .build();

  const agentSwagger = new DocumentBuilder()
    .setTitle("Lexia Unified Backend")
    .setDescription(
      "Unified backend: legal platform under /api/*, better-auth at /api/auth/*, " +
        "agent SSE at POST /chat/stream, other agent routes proxied to LEXIA_AGENT_URL.",
    )
    .setVersion("1.0")
    .addTag("Cross Tower")
    .addTag("Agent Chat")
    .addTag("Health")
    .build();

  const legalDoc = SwaggerModule.createDocument(app, legalSwagger);
  SwaggerModule.setup("api/docs", app, legalDoc);

  const baseDoc = SwaggerModule.createDocument(app, agentSwagger);
  mountMergedOpenApi(expressApp, baseDoc, "/docs-json");
  SwaggerModule.setup("docs", app, baseDoc, { jsonDocumentUrl: "docs-json" });

  app.enableShutdownHooks();
  await app.listen(port, "::");
  console.log(`Lexia backend listening on [::]:${port}`);
  console.log(`Legal Swagger: http://localhost:${port}/api/docs`);
  console.log(`Merged Swagger: http://localhost:${port}/docs`);
  console.log(`Bull Board: http://localhost:${port}/bull-board`);
}

void bootstrap();
