import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTIONS = [
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

const VECTOR_SIZE = 3072;

@Injectable()
export class QdrantService implements OnModuleInit {
  private client: QdrantClient;
  private readonly logger = new Logger(QdrantService.name);

  constructor(private configService: ConfigService) {
    const host = this.configService.get<string>('qdrant.host');
    const port = this.configService.get<number>('qdrant.port');
    const apiKey = this.configService.get<string>('qdrant.apiKey');

    this.client = new QdrantClient({
      host,
      port,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  async onModuleInit() {
    for (const collectionName of COLLECTIONS) {
      try {
        const exists = await this.collectionExists(collectionName);
        if (!exists) {
          await this.client.createCollection(collectionName, {
            vectors: {
              size: VECTOR_SIZE,
              distance: 'Cosine',
            },
          });
          this.logger.log(`Created Qdrant collection: ${collectionName}`);

          // Create payload indexes
          await this.client.createPayloadIndex(collectionName, {
            field_name: 'document_id',
            field_schema: 'keyword',
          });
          await this.client.createPayloadIndex(collectionName, {
            field_name: 'owner_id',
            field_schema: 'keyword',
          });
          await this.client.createPayloadIndex(collectionName, {
            field_name: 'visibility',
            field_schema: 'keyword',
          });
          await this.client.createPayloadIndex(collectionName, {
            field_name: 'collection',
            field_schema: 'keyword',
          });
        }
      } catch (err) {
        this.logger.error(`Failed to initialize collection ${collectionName}: ${err.message}`);
      }
    }
  }

  private async collectionExists(name: string): Promise<boolean> {
    try {
      const collections = await this.client.getCollections();
      return collections.collections.some((c) => c.name === name);
    } catch {
      return false;
    }
  }

  async search(
    collection: string,
    vector: number[],
    filter?: any,
    limit: number = 10,
  ): Promise<any[]> {
    const params: any = {
      vector,
      limit,
      with_payload: true,
      with_vector: false,
    };
    if (filter) params.filter = filter;

    const results = await this.client.search(collection, params);
    return results;
  }

  async upsert(collection: string, points: any[]): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points,
    });
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      points: ids,
    });
  }

  getClient(): QdrantClient {
    return this.client;
  }
}
