import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis pub/sub bridge between Bull workers (publishers) and HTTP SSE
 * endpoints (subscribers). A subscriber connection cannot also publish on
 * Redis, so the publisher is a single shared client and each subscriber
 * gets its own dedicated connection (cleaned up on unsubscribe).
 */
@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private publisher: Redis;
  private activeSubscribers = new Set<Redis>();

  constructor(private configService: ConfigService) {
    this.publisher = this.makeClient();
  }

  private makeClient(): Redis {
    const host = this.configService.get<string>('redis.host');
    const port = this.configService.get<number>('redis.port');
    const password = this.configService.get<string>('redis.password');
    const opts: any = {
      host,
      port,
      connectTimeout: 500,
      maxRetriesPerRequest: null,
      retryStrategy: () => null,
    };
    if (password) opts.password = password;
    const client = new Redis(opts);
    client.on('error', (err) => {
      this.logger.warn(`Redis pub/sub unavailable: ${err.message}`);
    });
    return client;
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    try {
      await this.publisher.publish(channel, JSON.stringify(payload));
    } catch (err: any) {
      this.logger.warn(
        `Skipping Redis publish to ${channel}: ${err?.message || err}`,
      );
    }
  }

  /**
   * Subscribe to a channel. Returns an unsubscribe function that closes the
   * dedicated connection. The handler receives the parsed JSON payload.
   */
  subscribe(
    channel: string,
    handler: (payload: any) => void,
  ): () => Promise<void> {
    const sub = this.makeClient();
    this.activeSubscribers.add(sub);

    try {
      sub.subscribe(channel, (err) => {
        if (err) {
          this.logger.warn(`Failed to subscribe to ${channel}: ${err.message}`);
        }
      });
    } catch (err: any) {
      this.logger.warn(`Failed to subscribe to ${channel}: ${err.message}`);
    }

    sub.on('message', (_ch, raw) => {
      try {
        handler(JSON.parse(raw));
      } catch (err) {
        this.logger.warn(`Bad pubsub payload on ${channel}: ${err.message}`);
      }
    });

    return async () => {
      this.activeSubscribers.delete(sub);
      try {
        await sub.unsubscribe(channel);
      } catch {
        /* ignore */
      }
      sub.disconnect();
    };
  }

  async onModuleDestroy() {
    for (const sub of this.activeSubscribers) sub.disconnect();
    this.activeSubscribers.clear();
    this.publisher.disconnect();
  }
}
