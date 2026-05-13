import { Injectable, Logger } from '@nestjs/common';
import { PostgresService } from '../../database/postgres.service';
import { QdrantService } from '../../database/qdrant.service';
import { EmbeddingService } from '../chat/agent/embedding.service';
import { AuthUser } from '../../common/guards/keycloak.guard';

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
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private postgresService: PostgresService,
    private qdrantService: QdrantService,
    private embeddingService: EmbeddingService,
  ) {}

  async search(
    query: string,
    collection?: string,
    mode: string = 'hybrid',
    page: number = 1,
    limit: number = 20,
    user?: AuthUser,
  ): Promise<{ results: any[]; total: number; page: number }> {
    const offset = (page - 1) * limit;
    const targetCollections = collection ? [collection] : ALL_COLLECTIONS;
    const accessLevel = user?.accessLevel || 'PUBLIC';
    const userId = user?.userId;

    let semanticResults: any[] = [];
    let fullTextResults: any[] = [];

    // Semantic search
    if (mode === 'semantic' || mode === 'hybrid') {
      try {
        const vector = await this.embeddingService.embedText(query);
        const filter = this.buildAccessFilter(accessLevel, userId);

        const promises = targetCollections.map((col) =>
          this.qdrantService
            .search(col, vector, filter, limit)
            .then((results) =>
              results.map((r) => ({
                id: String(r.id),
                score: r.score * 0.7, // weighted
                source: 'semantic',
                collection: col,
                documentId: r.payload?.document_id,
                content: r.payload?.content,
                articleRef: r.payload?.article_ref,
                visibility: r.payload?.visibility,
              })),
            )
            .catch(() => []),
        );

        semanticResults = (await Promise.all(promises)).flat();
      } catch (err) {
        this.logger.error(`Semantic search failed: ${err.message}`);
      }
    }

    // Full-text search
    if (mode === 'fulltext' || mode === 'hybrid') {
      try {
        const visibilityFilter = this.buildPgVisibilityFilter(accessLevel, userId);
        const collectionFilter = collection ? `AND collection = '${collection}'` : '';

        fullTextResults = await this.postgresService.query<any>(
          `SELECT
             dc.id,
             dc.document_id,
             dc.content,
             dc.article_ref,
             dc.collection,
             d.title_ar,
             d.title_fr,
             d.visibility,
             ts_rank(to_tsvector('arabic', dc.content), plainto_tsquery('arabic', $1)) * 0.3 as score
           FROM document_chunks dc
           JOIN documents d ON d.id = dc.document_id
           WHERE
             to_tsvector('arabic', dc.content) @@ plainto_tsquery('arabic', $1)
             ${visibilityFilter}
             ${collectionFilter}
           ORDER BY score DESC
           LIMIT $2 OFFSET $3`,
          [query, limit, offset],
        );
      } catch (err) {
        this.logger.warn(`Full-text search failed, falling back: ${err.message}`);
        // Fallback: ILIKE search
        try {
          fullTextResults = await this.postgresService.query<any>(
            `SELECT
               dc.id,
               dc.document_id,
               dc.content,
               dc.article_ref,
               dc.collection,
               d.title_ar,
               d.title_fr,
               d.visibility,
               0.3 as score
             FROM document_chunks dc
             JOIN documents d ON d.id = dc.document_id
             WHERE dc.content ILIKE $1
             ORDER BY dc.id
             LIMIT $2 OFFSET $3`,
            [`%${query}%`, limit, offset],
          );
        } catch {
          fullTextResults = [];
        }
      }
    }

    // Merge and deduplicate
    const merged = new Map<string, any>();

    for (const r of semanticResults) {
      const key = `${r.documentId}-${r.articleRef || r.id}`;
      if (!merged.has(key) || merged.get(key).score < r.score) {
        merged.set(key, r);
      }
    }

    for (const r of fullTextResults) {
      const key = `${r.document_id}-${r.article_ref || r.id}`;
      if (merged.has(key)) {
        const existing = merged.get(key);
        existing.score = (existing.score || 0) + (r.score || 0);
      } else {
        merged.set(key, {
          id: r.id,
          score: r.score,
          source: 'fulltext',
          collection: r.collection,
          documentId: r.document_id,
          content: r.content,
          articleRef: r.article_ref,
          titleAr: r.title_ar,
          titleFr: r.title_fr,
          visibility: r.visibility,
        });
      }
    }

    const results = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Enrich semantic results with metadata
    await this.enrichResults(results);

    return { results, total: results.length, page };
  }

  async suggest(query: string): Promise<string[]> {
    if (!query || query.length < 2) return [];

    try {
      const results = await this.postgresService.query<{ title_ar: string }>(
        `SELECT DISTINCT title_ar
         FROM documents
         WHERE title_ar ILIKE $1
           AND status = 'published'
         ORDER BY title_ar
         LIMIT 10`,
        [`%${query}%`],
      );
      return results.map((r) => r.title_ar).filter(Boolean);
    } catch {
      return [];
    }
  }

  async getDocument(id: string, user?: AuthUser): Promise<any> {
    const accessLevel = user?.accessLevel || 'PUBLIC';
    const userId = user?.userId;

    const doc = await this.postgresService.queryOne<any>(
      `SELECT d.*,
         (SELECT json_agg(dc.* ORDER BY dc.chunk_index LIMIT 5)
          FROM document_chunks dc
          WHERE dc.document_id = d.id) as chunks_preview
       FROM documents d
       WHERE d.id = $1`,
      [id],
    );

    if (!doc) return null;

    // Access check
    if (doc.visibility === 'private' && doc.owner_id !== userId) {
      return null;
    }
    if (doc.visibility === 'pro_only' && accessLevel === 'PUBLIC') {
      return null;
    }

    return doc;
  }

  private buildAccessFilter(accessLevel: string, userId?: string): any {
    if (accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN') return null;
    if (accessLevel === 'PRO' && userId) {
      return {
        should: [
          { key: 'visibility', match: { value: 'public' } },
          { key: 'visibility', match: { value: 'pro_only' } },
          { key: 'owner_id', match: { value: userId } },
        ],
      };
    }
    return { must: [{ key: 'visibility', match: { value: 'public' } }] };
  }

  private buildPgVisibilityFilter(accessLevel: string, userId?: string): string {
    if (accessLevel === 'ADMIN' || accessLevel === 'SUPERADMIN') return '';
    if (accessLevel === 'PRO' && userId) {
      return `AND (d.visibility IN ('public', 'pro_only') OR d.owner_id = '${userId}')`;
    }
    return `AND d.visibility = 'public'`;
  }

  private async enrichResults(results: any[]): Promise<void> {
    const docIds = [...new Set(results.filter((r) => r.documentId).map((r) => r.documentId))];
    if (docIds.length === 0) return;

    try {
      const placeholders = docIds.map((_, i) => `$${i + 1}`).join(', ');
      const docs = await this.postgresService.query<any>(
        `SELECT id, title_ar, title_fr, visibility FROM documents WHERE id IN (${placeholders})`,
        docIds,
      );
      const docMap = new Map(docs.map((d) => [d.id, d]));

      for (const r of results) {
        const doc = docMap.get(r.documentId);
        if (doc) {
          r.titleAr = r.titleAr || doc.title_ar;
          r.titleFr = r.titleFr || doc.title_fr;
          r.visibility = r.visibility || doc.visibility;
        }
      }
    } catch (err) {
      this.logger.warn(`Result enrichment failed: ${err.message}`);
    }
  }
}
