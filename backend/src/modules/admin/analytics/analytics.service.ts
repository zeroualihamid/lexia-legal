import { Injectable, Logger } from '@nestjs/common';
import { PostgresService } from '../../../database/postgres.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private redis: Redis;

  constructor(
    private postgresService: PostgresService,
    private configService: ConfigService,
  ) {
    const redisConfig: any = {
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      lazyConnect: true,
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    };
    const password = this.configService.get<string>('redis.password');
    if (password) redisConfig.password = password;
    this.redis = new Redis(redisConfig);
    this.redis.on('error', () => {
      /* Redis is optional for analytics; health endpoints report it separately. */
    });
  }

  async getDashboardStats(): Promise<any> {
    const [users, documents, revenue, subscriptions, realtime, collections, monthly] =
      await Promise.all([
        this.postgresService.queryOne<any>(
          `SELECT COUNT(DISTINCT user_id) AS total
           FROM (
             SELECT user_id FROM conversations
             UNION
             SELECT user_id FROM subscriptions
           ) u`,
        ),
        this.postgresService.queryOne<any>(`SELECT COUNT(*) AS total FROM documents`),
        this.postgresService.queryOne<any>(
          `SELECT COALESCE(SUM(sp.price_monthly_mad), 0) AS total
           FROM subscriptions s
           JOIN subscription_plans sp ON sp.id = s.plan_id
           WHERE s.status = 'active'`,
        ),
        this.postgresService.queryOne<any>(
          `SELECT COUNT(*) AS total FROM subscriptions WHERE status = 'active'`,
        ),
        this.getRealtime(),
        this.postgresService.query<any>(
          `SELECT collection, COUNT(*)::int AS count
           FROM documents
           GROUP BY collection
           ORDER BY count DESC`,
        ),
        this.postgresService.query<any>(
          `SELECT to_char(month, 'YYYY-MM') AS month,
                  COALESCE(SUM(messages_count), 0)::int AS messages,
                  COALESCE(SUM(searches_count), 0)::int AS searches
           FROM usage_records
           GROUP BY month
           ORDER BY month ASC
           LIMIT 12`,
        ),
      ]);

    return {
      total_users: parseInt(users?.total || '0', 10),
      total_documents: parseInt(documents?.total || '0', 10),
      total_revenue: parseFloat(revenue?.total || '0'),
      active_subscriptions: parseInt(subscriptions?.total || '0', 10),
      active_users_hour: realtime.activeUsersLastHour,
      messages_hour: realtime.messagesLastHour,
      collections,
      monthly_usage: monthly,
    };
  }

  async getOverview(): Promise<any> {
    const [users, documents, conversations, billing] = await Promise.all([
      this.postgresService.queryOne<any>(
        `SELECT COUNT(*) as total FROM conversations`,
      ),
      this.postgresService.queryOne<any>(
        `SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'published' THEN 1 END) as published
         FROM documents`,
      ),
      this.postgresService.queryOne<any>(
        `SELECT COUNT(*) as total FROM conversations`,
      ),
      this.postgresService.queryOne<any>(
        `SELECT COALESCE(SUM(sp.price_mad), 0) as total_revenue
         FROM subscriptions s
         JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.status = 'active'`,
      ),
    ]);

    return {
      totalDocuments: parseInt(documents?.total || '0'),
      publishedDocuments: parseInt(documents?.published || '0'),
      totalConversations: parseInt(conversations?.total || '0'),
      totalRevenueMAD: parseFloat(billing?.total_revenue || '0'),
    };
  }

  async getRealtime(): Promise<any> {
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();

    const [activeMessages, pendingJobs] = await Promise.all([
      this.postgresService.queryOne<any>(
        `SELECT COUNT(*) as count FROM messages WHERE created_at > $1`,
        [oneHourAgo],
      ),
      this.postgresService.queryOne<any>(
        `SELECT COUNT(*) as count FROM documents WHERE status = 'processing'`,
      ),
    ]);

    // Get active sessions from Redis
    let activeSessions = 0;
    try {
      const keys = await this.redis.keys('session:*');
      activeSessions = keys.length;
    } catch {
      activeSessions = 0;
    }

    return {
      activeUsersLastHour: activeSessions,
      messagesLastHour: parseInt(activeMessages?.count || '0'),
      jobsPending: parseInt(pendingJobs?.count || '0'),
    };
  }

  async getCosts(month: string): Promise<any> {
    const target = month || new Date().toISOString().slice(0, 7);
    const monthStart = `${target}-01`;

    const usage = await this.postgresService.query<any>(
      `SELECT
         user_id,
         SUM(messages_count) as total_messages,
         SUM(searches_count) as total_searches
       FROM usage_records
       WHERE month = $1
       GROUP BY user_id
       ORDER BY total_messages DESC`,
      [monthStart],
    );

    const totals = await this.postgresService.queryOne<any>(
      `SELECT
         SUM(messages_count) as total_messages,
         SUM(searches_count) as total_searches
       FROM usage_records WHERE month = $1`,
      [monthStart],
    );

    return {
      month: target,
      byUser: usage,
      totals: {
        messages: parseInt(totals?.total_messages || '0'),
        searches: parseInt(totals?.total_searches || '0'),
      },
    };
  }

  async getCollections(): Promise<any[]> {
    return this.postgresService.query<any>(
      `SELECT
         collection,
         COUNT(*) as document_count,
         COUNT(CASE WHEN status = 'published' THEN 1 END) as published_count,
         SUM(word_count) as total_words
       FROM documents
       WHERE collection IS NOT NULL
       GROUP BY collection
       ORDER BY document_count DESC`,
    );
  }

  async getMonthlyReport(month: string): Promise<any> {
    const target = month || new Date().toISOString().slice(0, 7);
    const monthStart = `${target}-01`;
    const monthEnd = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1))
      .toISOString()
      .slice(0, 10);

    const [documents, conversations, subscriptions, usage] = await Promise.all([
      this.postgresService.queryOne<any>(
        `SELECT COUNT(*) as total FROM documents WHERE created_at >= $1 AND created_at < $2`,
        [monthStart, monthEnd],
      ),
      this.postgresService.queryOne<any>(
        `SELECT COUNT(*) as total FROM conversations WHERE created_at >= $1 AND created_at < $2`,
        [monthStart, monthEnd],
      ),
      this.postgresService.queryOne<any>(
        `SELECT
           COUNT(*) as new_subscriptions,
           COALESCE(SUM(sp.price_mad), 0) as revenue
         FROM subscriptions s
         JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.created_at >= $1 AND s.created_at < $2`,
        [monthStart, monthEnd],
      ),
      this.postgresService.queryOne<any>(
        `SELECT
           COALESCE(SUM(messages_count), 0) as total_messages,
           COALESCE(SUM(searches_count), 0) as total_searches
         FROM usage_records WHERE month = $1`,
        [monthStart],
      ),
    ]);

    return {
      month: target,
      newDocuments: parseInt(documents?.total || '0'),
      newConversations: parseInt(conversations?.total || '0'),
      newSubscriptions: parseInt(subscriptions?.new_subscriptions || '0'),
      revenue: parseFloat(subscriptions?.revenue || '0'),
      totalMessages: parseInt(usage?.total_messages || '0'),
      totalSearches: parseInt(usage?.total_searches || '0'),
    };
  }
}
