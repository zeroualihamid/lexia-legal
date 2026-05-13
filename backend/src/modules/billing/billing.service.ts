import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresService } from '../../database/postgres.service';
import { MinioService } from '../storage/minio.service';
import axios from 'axios';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private postgresService: PostgresService,
    private minioService: MinioService,
    private configService: ConfigService,
  ) {}

  async getPlans(): Promise<any[]> {
    return this.postgresService.query(
      `SELECT * FROM subscription_plans WHERE is_active = true ORDER BY price_mad ASC`,
    );
  }

  async getMySubscription(userId: string): Promise<any> {
    return this.postgresService.queryOne(
      `SELECT s.*, sp.name, sp.price_mad, sp.features, sp.message_limit, sp.search_limit
       FROM subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.user_id = $1 AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
      [userId],
    );
  }

  async subscribe(
    userId: string,
    planId: string,
    paymentMethod: string,
  ): Promise<any> {
    const plan = await this.postgresService.queryOne<any>(
      `SELECT * FROM subscription_plans WHERE id = $1 AND is_active = true`,
      [planId],
    );

    if (!plan) throw new NotFoundException('Plan not found');

    const subscription = await this.postgresService.transaction(async (client) => {
      // Cancel existing subscription if any
      await client.query(
        `UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`,
        [userId],
      );

      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      const result = await client.query(
        `INSERT INTO subscriptions
           (user_id, plan_id, status, payment_method, current_period_start, current_period_end, auto_renew)
         VALUES ($1, $2, 'active', $3, $4, $5, true)
         RETURNING *`,
        [userId, planId, paymentMethod, now, periodEnd],
      );

      return result.rows[0];
    });

    // Assign pro role in Keycloak
    try {
      await this.assignKeycloakRole(userId, 'pro');
    } catch (err) {
      this.logger.error(`Failed to assign Keycloak role: ${err.message}`);
    }

    return subscription;
  }

  async cancelSubscription(userId: string): Promise<void> {
    await this.postgresService.query(
      `UPDATE subscriptions SET status = 'cancelled' WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );

    try {
      await this.revokeKeycloakRole(userId, 'pro');
    } catch (err) {
      this.logger.error(`Failed to revoke Keycloak role: ${err.message}`);
    }
  }

  async toggleAutoRenew(userId: string, autoRenew: boolean): Promise<any> {
    return this.postgresService.queryOne(
      `UPDATE subscriptions SET auto_renew = $1
       WHERE user_id = $2 AND status = 'active'
       RETURNING *`,
      [autoRenew, userId],
    );
  }

  async getCurrentUsage(userId: string): Promise<any> {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    return this.postgresService.queryOne(
      `SELECT * FROM usage_records WHERE user_id = $1 AND month = $2`,
      [userId, month],
    );
  }

  async getUsageHistory(userId: string): Promise<any[]> {
    return this.postgresService.query(
      `SELECT * FROM usage_records
       WHERE user_id = $1
       ORDER BY month DESC LIMIT 6`,
      [userId],
    );
  }

  async getInvoices(userId: string): Promise<any[]> {
    return this.postgresService.query(
      `SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
  }

  async getInvoicePdf(userId: string, invoiceId: string): Promise<Buffer> {
    const invoice = await this.postgresService.queryOne<any>(
      `SELECT * FROM invoices WHERE id = $1 AND user_id = $2`,
      [invoiceId, userId],
    );

    if (!invoice) throw new NotFoundException('Invoice not found');

    return this.minioService.downloadFile('invoices', invoice.storage_key);
  }

  async adminOverview(): Promise<any> {
    const [revenue, subscribers, mrr] = await Promise.all([
      this.postgresService.queryOne<any>(
        `SELECT
           COALESCE(SUM(sp.price_mad), 0) as total_revenue_mad,
           COUNT(*) as total_subscriptions
         FROM subscriptions s
         JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.status = 'active'`,
      ),
      this.postgresService.queryOne<any>(
        `SELECT COUNT(DISTINCT user_id) as active_subscribers FROM subscriptions WHERE status = 'active'`,
      ),
      this.postgresService.queryOne<any>(
        `SELECT
           COALESCE(SUM(sp.price_mad), 0) as mrr
         FROM subscriptions s
         JOIN subscription_plans sp ON sp.id = s.plan_id
         WHERE s.status = 'active'`,
      ),
    ]);

    return {
      totalRevenueMAD: revenue?.total_revenue_mad || 0,
      totalSubscriptions: revenue?.total_subscriptions || 0,
      activeSubscribers: subscribers?.active_subscribers || 0,
      monthlyRecurringRevenue: mrr?.mrr || 0,
    };
  }

  private async getAdminToken(): Promise<string> {
    const url = this.configService.get<string>('keycloak.url');
    const response = await axios.post(
      `${url}/realms/master/protocol/openid-connect/token`,
      new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'admin',
        password: this.configService.get<string>('keycloak.adminPassword'),
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    return response.data.access_token;
  }

  private async assignKeycloakRole(userId: string, roleName: string): Promise<void> {
    const token = await this.getAdminToken();
    const url = this.configService.get<string>('keycloak.url');
    const realm = this.configService.get<string>('keycloak.realm');

    // Get role info
    const roleResp = await axios.get(
      `${url}/admin/realms/${realm}/roles/${roleName}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    // Assign to user
    await axios.post(
      `${url}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      [roleResp.data],
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }

  private async revokeKeycloakRole(userId: string, roleName: string): Promise<void> {
    const token = await this.getAdminToken();
    const url = this.configService.get<string>('keycloak.url');
    const realm = this.configService.get<string>('keycloak.realm');

    const roleResp = await axios.get(
      `${url}/admin/realms/${realm}/roles/${roleName}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    await axios.delete(
      `${url}/admin/realms/${realm}/users/${userId}/role-mappings/realm`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: [roleResp.data],
      },
    );
  }
}
