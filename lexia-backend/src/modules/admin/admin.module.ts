import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';

// Skills
import { SkillsController } from './skills/skills.controller';
import { SkillsService } from './skills/skills.service';

// Tools
import { ToolsController } from './tools/tools.controller';
import { ToolsService } from './tools/tools.service';

// MCP
import { McpController } from './mcp/mcp.controller';
import { McpService } from './mcp/mcp.service';

// Scraper
import { ScraperAdminController } from './scraper/scraper-admin.controller';
import { ScraperAdminService } from './scraper/scraper-admin.service';

// Users
import { UsersController } from './users/users.controller';
import { UsersModule } from './users/users.module';

// Analytics
import { AnalyticsController } from './analytics/analytics.controller';
import { AnalyticsService } from './analytics/analytics.service';

// Agent Config
import { AgentConfigController } from './agent-config/agent-config.controller';
import { AgentConfigService } from './agent-config/agent-config.service';

// Chat Module for ToolExecutorService
import { ChatModule } from '../chat/chat.module';

// Judgment Analysis (Claude Code CLI)
import { JudgmentAnalysisModule } from './judgment-analysis/judgment-analysis.module';

// Admin documents (upload + per-document page viewer)
import { AdminDocumentsModule } from './documents/admin-documents.module';

@Module({
  imports: [
    ChatModule,
    JudgmentAnalysisModule,
    UsersModule,
    AdminDocumentsModule,
    BullModule.registerQueue(
      { name: 'scraping' },
      { name: 'document-processing' },
    ),
  ],
  controllers: [
    SkillsController,
    ToolsController,
    McpController,
    ScraperAdminController,
    UsersController,
    AnalyticsController,
    AgentConfigController,
  ],
  providers: [
    SkillsService,
    ToolsService,
    McpService,
    ScraperAdminService,
    AnalyticsService,
    AgentConfigService,
  ],
})
export class AdminModule {}
