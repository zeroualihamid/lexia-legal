import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/legal-graphs')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class LegalGraphsController {
  private readonly logger = new Logger(LegalGraphsController.name);

  constructor(private readonly configService: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'List generated legal graph artifacts' })
  async listGraphs() {
    const data = await this.agentJson('/legal-graphs');
    return this.rewriteArtifactUrls(data);
  }

  @Post('build')
  @ApiOperation({ summary: 'Build a judgment-only legal graph from Qdrant/MinIO chunks' })
  async buildGraph(@Body() body: Record<string, unknown>) {
    const data = await this.agentJson('/legal-graphs/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return this.rewriteArtifactUrls(data);
  }

  @Post('build-jobs')
  @ApiOperation({ summary: 'Start a judgment-only legal graph build job' })
  async startBuildJob(@Body() body: Record<string, unknown>) {
    const data = await this.agentJson('/legal-graphs/build-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return this.rewriteArtifactUrls(data);
  }

  @Get('build-jobs/:jobId')
  @ApiOperation({ summary: 'Get a legal graph build job status' })
  async buildJobStatus(@Param('jobId') jobId: string) {
    const data = await this.agentJson(`/legal-graphs/build-jobs/${encodeURIComponent(jobId)}`);
    return this.rewriteArtifactUrls(data);
  }

  @Get('explore/presets')
  @ApiOperation({ summary: 'List preset legal graph exploration queries' })
  async explorePresets() {
    return this.agentJson('/legal-graphs/explore/presets');
  }

  @Post(':graphId/explore/query')
  @ApiOperation({ summary: 'Explore a legal graph subgraph for a preset or query' })
  async exploreQuery(
    @Param('graphId') graphId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.agentJson(
      `/legal-graphs/${encodeURIComponent(graphId)}/explore/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      },
    );
  }

  @Post(':graphId/explore/path')
  @ApiOperation({ summary: 'Find A* reasoning path from a node and summarize it' })
  async explorePath(
    @Param('graphId') graphId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.agentJson(
      `/legal-graphs/${encodeURIComponent(graphId)}/explore/path`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      },
    );
  }

  @Get(':graphId/images/:filename')
  @ApiOperation({ summary: 'Proxy a legal graph PNG image' })
  async image(
    @Param('graphId') graphId: string,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    return this.agentFile(`/legal-graphs/${encodeURIComponent(graphId)}/images/${encodeURIComponent(filename)}`, res);
  }

  @Get(':graphId/files/:filename')
  @ApiOperation({ summary: 'Proxy a legal graph artifact download' })
  async file(
    @Param('graphId') graphId: string,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    return this.agentFile(`/legal-graphs/${encodeURIComponent(graphId)}/files/${encodeURIComponent(filename)}`, res);
  }

  private agentBaseUrl(): string {
    return (this.configService.get<string>('agent.url') || 'http://localhost:8000').replace(/\/+$/, '');
  }

  private async agentJson(path: string, init?: RequestInit) {
    const url = `${this.agentBaseUrl()}${path}`;
    let agentResponse: globalThis.Response;
    try {
      agentResponse = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent unreachable at ${url}: ${reason}`);
      throw new HttpException(
        'Le service agent (lexia-agent) est indisponible. Réessayez dans quelques secondes.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const text = await agentResponse.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { detail: text };
    }

    if (!agentResponse.ok) {
      const message =
        typeof data === 'object' && data !== null && 'detail' in data
          ? String((data as { detail?: unknown }).detail)
          : `Agent request failed (${agentResponse.status})`;
      throw new HttpException(message, agentResponse.status);
    }
    return data;
  }

  private async agentFile(path: string, res: ExpressResponse) {
    let agentResponse: globalThis.Response;
    try {
      agentResponse = await fetch(`${this.agentBaseUrl()}${path}`, {
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent file proxy failed for ${path}: ${reason}`);
      throw new HttpException(
        'Le service agent (lexia-agent) est indisponible. Réessayez dans quelques secondes.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (!agentResponse.ok) {
      res.status(agentResponse.status);
      return { error: await agentResponse.text() };
    }

    const contentType = agentResponse.headers.get('content-type');
    const contentDisposition = agentResponse.headers.get('content-disposition');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

    const buffer = Buffer.from(await agentResponse.arrayBuffer());
    return new StreamableFile(buffer);
  }

  private rewriteArtifactUrls(data: unknown): unknown {
    if (!data || typeof data !== 'object') return data;
    const clone = JSON.parse(JSON.stringify(data));

    const rewriteUrl = (url: unknown) => {
      if (typeof url !== 'string') return url;
      return url.replace(/^\/legal-graphs\//, '/api/admin/legal-graphs/');
    };

    const rewriteGraph = (graph: Record<string, unknown>) => {
      for (const key of ['images', 'files']) {
        const items = Array.isArray(graph[key]) ? (graph[key] as Record<string, unknown>[]) : [];
        for (const item of items) {
          item.url = rewriteUrl(item.url);
        }
      }
    };

    if (Array.isArray(clone.graphs)) {
      for (const graph of clone.graphs) rewriteGraph(graph);
    }
    if (clone.graph && typeof clone.graph === 'object') {
      rewriteGraph(clone.graph);
    }
    return clone;
  }
}
