import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { QdrantService } from '../../../database/qdrant.service';
import { PostgresService } from '../../../database/postgres.service';
import OpenAI from 'openai';

export interface SearchResult {
  id: string;
  score: number;
  collection: string;
  documentId: string;
  content: string;
  articleRef?: string;
  titleAr?: string;
  titleFr?: string;
  visibility: string;
}

const ALL_COLLECTIONS = [
  'legal_laws',
  'judgments_commercial',
  'judgments_civil',
  'judgments_admin',
  'judgments_criminal',
  'judgments_family',
  'judgments_social',
  'judgments_real_estate',
  'judgments_constitutional',
  'user_documents',
];

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private embeddingService: EmbeddingService,
    private qdrantService: QdrantService,
    private postgresService: PostgresService,
  ) {}

  async routeCollections(
    question: string,
    openaiClient: OpenAI,
  ): Promise<Array<{ collection: string; score: number }>> {
    try {
      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a legal routing assistant for a Moroccan legal AI system.
Given a legal question, determine which document collections are relevant.
Collections available:
- legal_laws: Moroccan laws and legislation
- judgments_commercial: Commercial court decisions
- judgments_civil: Civil court decisions
- judgments_admin: Administrative court decisions
- judgments_criminal: Criminal court decisions
- judgments_family: Family court decisions
- judgments_social: Social court decisions
- judgments_real_estate: Real estate court decisions
- judgments_constitutional: Constitutional court decisions
- user_documents: User uploaded documents

Respond with JSON: { "collections": [{ "collection": "name", "score": 0.0-1.0 }] }
Only include collections with score >= 0.3. Score reflects relevance.`,
          },
          { role: 'user', content: question },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 300,
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      const collections: Array<{ collection: string; score: number }> =
        parsed.collections || [];

      return collections.filter((c) => c.score >= 0.5);
    } catch (err) {
      this.logger.error(`Collection routing failed: ${err.message}`);
      return [
        { collection: 'legal_laws', score: 0.8 },
        { collection: 'judgments_civil', score: 0.6 },
      ];
    }
  }

  async search(
    question: string,
    collections: string[],
    accessLevel: string,
    userId?: string,
    openaiClient?: OpenAI,
  ): Promise<SearchResult[]> {
    const vector = await this.embeddingService.embedText(question);
    const filter = this.buildAccessFilter(accessLevel, userId);

    const targetCollections =
      collections.length > 0 ? collections : ALL_COLLECTIONS;

    const searchPromises = targetCollections.map((collection) =>
      this.qdrantService
        .search(collection, vector, filter, 10)
        .then((results) =>
          results.map((r) => ({
            id: String(r.id),
            score: r.score,
            collection,
            documentId: r.payload?.document_id as string,
            content: r.payload?.content as string,
            articleRef: r.payload?.article_ref as string,
            visibility: r.payload?.visibility as string,
          })),
        )
        .catch((err) => {
          this.logger.warn(`Search failed for collection ${collection}: ${err.message}`);
          return [];
        }),
    );

    const allResults = (await Promise.all(searchPromises)).flat();

    // Deduplicate by id
    const seen = new Set<string>();
    const unique = allResults.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });

    // Sort by score
    unique.sort((a, b) => b.score - a.score);
    const top10 = unique.slice(0, 10);

    // Enrich with PostgreSQL metadata
    await this.enrichWithMetadata(top10);

    return top10;
  }

  private buildAccessFilter(accessLevel: string, userId?: string): any {
    if (accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN') {
      return null;
    }

    if (accessLevel === 'PRO' && userId) {
      return {
        should: [
          { key: 'visibility', match: { value: 'public' } },
          { key: 'visibility', match: { value: 'pro_only' } },
          { key: 'owner_id', match: { value: userId } },
        ],
      };
    }

    // PUBLIC
    return {
      must: [{ key: 'visibility', match: { value: 'public' } }],
    };
  }

  private async enrichWithMetadata(results: SearchResult[]): Promise<void> {
    if (results.length === 0) return;

    const documentIds = [
      ...new Set(results.map((r) => r.documentId).filter(Boolean)),
    ];
    if (documentIds.length === 0) return;

    try {
      const placeholders = documentIds.map((_, i) => `$${i + 1}`).join(', ');
      const docs = await this.postgresService.query<{
        id: string;
        title_ar: string;
        title_fr: string;
      }>(
        `SELECT id, title_ar, title_fr FROM documents WHERE id IN (${placeholders})`,
        documentIds,
      );

      const docMap = new Map(docs.map((d) => [d.id, d]));

      for (const result of results) {
        const doc = docMap.get(result.documentId);
        if (doc) {
          result.titleAr = doc.title_ar;
          result.titleFr = doc.title_fr;
        }
      }
    } catch (err) {
      this.logger.warn(`Metadata enrichment failed: ${err.message}`);
    }
  }

  buildContext(results: SearchResult[]): string {
    if (results.length === 0) return '';

    let context = 'المصادر القانونية ذات الصلة:\n\n';

    results.forEach((r, i) => {
      const source = r.titleAr || r.titleFr || `المصدر ${i + 1}`;
      const articleInfo = r.articleRef ? ` - ${r.articleRef}` : '';
      context += `[${i + 1}] ${source}${articleInfo}\n`;
      context += `${r.content}\n\n`;
    });

    return context;
  }
}
