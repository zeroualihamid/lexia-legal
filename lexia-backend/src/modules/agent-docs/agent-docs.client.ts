import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface AgentIndexParams {
  ownerId: string;
  caseId: string;
  documentId: string;
  documentType?: string;
  title?: string;
  text: string;
}

export interface AgentSearchParams {
  ownerId: string;
  query: string;
  caseId?: string;
  documentId?: string;
  limit?: number;
}

export interface AgentSearchHit {
  documentId: string;
  caseId: string | null;
  docType: string | null;
  chunkIndex: number;
  content: string;
  score: number;
}

/**
 * Thin HTTP client for the lexia-agent FastEmbed/Qdrant user-document
 * endpoints. Calls are authenticated with a shared internal secret header
 * (the agent has no incoming OIDC auth). All methods are best-effort from the
 * caller's perspective — they throw on transport errors so the queue/SSE
 * handlers can decide how to react.
 */
@Injectable()
export class AgentDocsClient {
  private readonly logger = new Logger(AgentDocsClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    const baseURL = this.configService.get<string>('agent.url');
    const secret = this.configService.get<string>('agent.internalSecret');
    this.http = axios.create({
      baseURL,
      timeout: 120000,
      headers: secret ? { 'x-internal-secret': secret } : {},
    });
  }

  async index(params: AgentIndexParams): Promise<{ chunks: number }> {
    const { data } = await this.http.post('/documents/index', {
      owner_id: params.ownerId,
      case_id: params.caseId,
      document_id: params.documentId,
      doc_type: params.documentType || null,
      title: params.title || null,
      text: params.text,
    });
    return { chunks: data?.chunks ?? 0 };
  }

  async search(params: AgentSearchParams): Promise<AgentSearchHit[]> {
    const { data } = await this.http.post('/documents/search', {
      owner_id: params.ownerId,
      query: params.query,
      case_id: params.caseId || null,
      document_id: params.documentId || null,
      limit: params.limit || 10,
    });
    const hits: any[] = data?.hits || [];
    return hits.map((h) => ({
      documentId: h.document_id,
      caseId: h.case_id ?? null,
      docType: h.doc_type ?? null,
      chunkIndex: h.chunk_index ?? 0,
      content: h.content || '',
      score: h.score ?? 0,
    }));
  }

  async deleteDocument(ownerId: string, documentId: string): Promise<void> {
    await this.http.delete(`/documents/${documentId}`, {
      params: { owner_id: ownerId },
    });
  }

  async deleteCase(ownerId: string, caseId: string): Promise<void> {
    await this.http.delete(`/cases/${caseId}/documents`, {
      params: { owner_id: ownerId },
    });
  }
}
