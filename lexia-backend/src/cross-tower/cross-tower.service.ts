import { randomUUID } from "node:crypto";
import { auth } from "../auth";
import { ensureCrossTowerSchema, pool } from "./db";

/**
 * Cross-Tower domain service, backed by Postgres (see db.ts for the schema).
 * Every read returns camelCase rows; rows that carry a tenant_id are enriched
 * with the matching `tenant` object so the frontend keeps its current shape.
 */

const TENANT_COLS = `id, name, floor, office_number AS "officeNumber", legal_name AS "legalName",
  activity, registration_number AS "registrationNumber", ice, tax_id AS "taxId",
  contact_email AS "contactEmail", contact_name AS "contactName", contact_phone AS "contactPhone",
  billing_email AS "billingEmail", emergency_contact AS "emergencyContact",
  lease_start AS "leaseStart", lease_end AS "leaseEnd", area_sqm AS "areaSqm",
  website, status, notes, employees`;
const BADGE_COLS = `id, tenant_id AS "tenantId", holder, type, status, requested_at AS "requestedAt", valid_until AS "validUntil"`;
const VISITOR_COLS = `id, tenant_id AS "tenantId", name, company, email, phone, expected_at AS "expectedAt", checked_in_at AS "checkedInAt", checked_out_at AS "checkedOutAt", status, badge_id AS "badgeId"`;
const RESERVATION_COLS = `id, spot_number AS "spotNumber", tenant_id AS "tenantId", visitor_name AS "visitorName", start_time AS "startTime", end_time AS "endTime", status, penalty, charging_kwh AS "chargingKwh"`;
const TICKET_COLS = `id, reference, title, tenant_id AS "tenantId", location, category, priority, status, sla_status AS "slaStatus", created_at AS "createdAt", assignee`;
const EVENT_COLS = `id, title, description, start_time AS "start", end_time AS "end", type, location, agenda_id AS "agendaId"`;
const BOH_COLS = `id, name, category, location, status, provider_id AS "providerId", last_service_at AS "lastServiceAt", next_service_at AS "nextServiceAt", notes`;
const PROVIDER_COLS = `id, name, service, sla, status, legal_name AS "legalName",
  contract_ref AS "contractRef", contact_name AS "contactName", contact_email AS "contactEmail",
  contact_phone AS "contactPhone", emergency_phone AS "emergencyPhone", address, ice,
  insurance_expiry AS "insuranceExpiry", contract_start AS "contractStart", contract_end AS "contractEnd",
  certifications, notes`;

type TenantPayload = {
  name?: string; floor?: number; officeNumber?: string; legalName?: string; activity?: string;
  registrationNumber?: string; ice?: string; taxId?: string; contactEmail?: string; contactName?: string;
  contactPhone?: string; billingEmail?: string; emergencyContact?: string; leaseStart?: string | null;
  leaseEnd?: string | null; areaSqm?: number | null; website?: string; status?: string; notes?: string;
  employees?: number;
};

type ProviderPayload = {
  name?: string; service?: string; sla?: number; status?: string; legalName?: string; contractRef?: string;
  contactName?: string; contactEmail?: string; contactPhone?: string; emergencyPhone?: string; address?: string;
  ice?: string; insuranceExpiry?: string | null; contractStart?: string | null; contractEnd?: string | null;
  certifications?: string; notes?: string;
};

type Row = Record<string, unknown>;

export class CrossTowerService {
  private async db() {
    await ensureCrossTowerSchema();
    return pool;
  }

  private async enrichWithTenant<T extends Row>(rows: T[]): Promise<(T & { tenant: Row | null })[]> {
    const ids = [...new Set(rows.map((r) => r.tenantId).filter(Boolean))] as string[];
    if (ids.length === 0) return rows.map((r) => ({ ...r, tenant: null }));
    const { rows: tenants } = await pool.query(
      `SELECT ${TENANT_COLS} FROM ct_tenant WHERE id = ANY($1)`,
      [ids],
    );
    const byId = new Map(tenants.map((t) => [t.id, t]));
    return rows.map((r) => ({ ...r, tenant: r.tenantId ? byId.get(r.tenantId as string) ?? null : null }));
  }

  // ── Dashboard ──────────────────────────────────────────────────────────

  async getDashboard() {
    const db = await this.db();
    const [kpiBadges, kpiVisitors, kpiParking, kpiTickets, prio, sla] = await Promise.all([
      db.query(`SELECT
          count(*) FILTER (WHERE status = 'active')::int AS active,
          count(*) FILTER (WHERE requested_at >= now() - interval '7 days')::int AS new_week
        FROM ct_badge`),
      db.query(`SELECT
          count(*) FILTER (WHERE checked_in_at::date = current_date)::int AS today,
          count(*) FILTER (WHERE status = 'expected' AND expected_at::date = current_date)::int AS expected
        FROM ct_visitor`),
      db.query(`SELECT
          count(*) FILTER (WHERE status IN ('confirmed','in_progress','overstay'))::int AS occupied,
          count(*) FILTER (WHERE status = 'overstay')::int AS overstays,
          coalesce(sum(penalty) FILTER (WHERE status = 'overstay'), 0)::int AS penalties,
          (SELECT count(*)::int FROM ct_parking_spot) AS total
        FROM ct_parking_reservation`),
      db.query(`SELECT
          count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open,
          count(*) FILTER (WHERE sla_status = 'breached')::int AS breached
        FROM ct_ticket`),
      db.query(`SELECT ${TICKET_COLS} FROM ct_ticket
        WHERE status IN ('open','in_progress')
        ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at DESC
        LIMIT 5`),
      db.query(`SELECT service, round(avg(sla))::int AS sla FROM ct_provider
        WHERE service IN ('cleaning','security','hygiene_3d','maintenance')
        GROUP BY service`),
    ]);

    const b = kpiBadges.rows[0];
    const v = kpiVisitors.rows[0];
    const p = kpiParking.rows[0];
    const t = kpiTickets.rows[0];

    return {
      kpi: {
        visitorsToday: v.today,
        visitorsExpected: v.expected,
        parkingOccupied: p.occupied,
        parkingTotal: p.total,
        overstays: p.overstays,
        openTickets: t.open,
        slaBreached: t.breached,
        activeBadges: b.active,
        newBadgesWeek: b.new_week,
        revenue: {
          badges: 12400,
          parkingPenalties: p.penalties,
          chargingStations: 8750,
        },
      },
      priorityTickets: await this.enrichWithTenant(prio.rows),
      providerSla: sla.rows,
    };
  }

  // ── Tenants ────────────────────────────────────────────────────────────

  async getTenants() {
    const db = await this.db();
    const { rows } = await db.query(`SELECT ${TENANT_COLS} FROM ct_tenant ORDER BY floor DESC, name`);
    return rows;
  }

  async createTenant(body: TenantPayload) {
    const {
      name, floor, officeNumber, legalName, activity, registrationNumber, ice, taxId,
      contactEmail, contactName, contactPhone, billingEmail, emergencyContact,
      leaseStart, leaseEnd, areaSqm, website, status, notes, employees,
    } = body;
    if (!name) return { error: "name is required", status: 400 as const };
    const db = await this.db();
    const { rows } = await db.query(
      `INSERT INTO ct_tenant (
         id, name, floor, office_number, legal_name, activity, registration_number, ice, tax_id,
         contact_email, contact_name, contact_phone, billing_email, emergency_contact,
         lease_start, lease_end, area_sqm, website, status, notes, employees
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING ${TENANT_COLS}`,
      [
        randomUUID(), name, floor ?? 0, officeNumber ?? "", legalName ?? name, activity ?? "",
        registrationNumber ?? "", ice ?? "", taxId ?? "", contactEmail ?? "", contactName ?? "",
        contactPhone ?? "", billingEmail ?? contactEmail ?? "", emergencyContact ?? "", leaseStart ?? null,
        leaseEnd ?? null, areaSqm ?? null, website ?? "", status ?? "active", notes ?? "", employees ?? 0,
      ],
    );
    return { data: rows[0], status: 201 as const };
  }

  async updateTenant(id: string, body: Partial<TenantPayload>) {
    const db = await this.db();
    const { rows } = await db.query(
      `UPDATE ct_tenant SET
         name = coalesce($2, name),
         floor = coalesce($3, floor),
         office_number = coalesce($4, office_number),
         legal_name = coalesce($5, legal_name),
         activity = coalesce($6, activity),
         registration_number = coalesce($7, registration_number),
         ice = coalesce($8, ice),
         tax_id = coalesce($9, tax_id),
         contact_email = coalesce($10, contact_email),
         contact_name = coalesce($11, contact_name),
         contact_phone = coalesce($12, contact_phone),
         billing_email = coalesce($13, billing_email),
         emergency_contact = coalesce($14, emergency_contact),
         lease_start = coalesce($15, lease_start),
         lease_end = coalesce($16, lease_end),
         area_sqm = coalesce($17, area_sqm),
         website = coalesce($18, website),
         status = coalesce($19, status),
         notes = coalesce($20, notes),
         employees = coalesce($21, employees)
       WHERE id = $1 RETURNING ${TENANT_COLS}`,
      [
        id, body.name ?? null, body.floor ?? null, body.officeNumber ?? null, body.legalName ?? null,
        body.activity ?? null, body.registrationNumber ?? null, body.ice ?? null, body.taxId ?? null,
        body.contactEmail ?? null, body.contactName ?? null, body.contactPhone ?? null,
        body.billingEmail ?? null, body.emergencyContact ?? null, body.leaseStart ?? null,
        body.leaseEnd ?? null, body.areaSqm ?? null, body.website ?? null, body.status ?? null,
        body.notes ?? null, body.employees ?? null,
      ],
    );
    if (rows.length === 0) return { error: "Tenant not found", status: 404 as const };
    return { data: rows[0], status: 200 as const };
  }

  private async tenantExists(id: string): Promise<boolean> {
    const { rows } = await pool.query("SELECT 1 FROM ct_tenant WHERE id = $1", [id]);
    return rows.length > 0;
  }

  // ── Badges ─────────────────────────────────────────────────────────────

  async getBadges(type?: string, status?: string) {
    const db = await this.db();
    const where: string[] = [];
    const params: unknown[] = [];
    if (type) { params.push(type); where.push(`type = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const { rows } = await db.query(
      `SELECT ${BADGE_COLS} FROM ct_badge ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY requested_at DESC`,
      params,
    );
    return this.enrichWithTenant(rows);
  }

  async createBadge(body: { tenantId?: string; holder?: string; type?: string; validUntil?: string | null }) {
    const { tenantId, holder, type, validUntil } = body;
    if (!tenantId || !holder || !type) {
      return { error: "tenantId, holder, and type are required", status: 400 as const };
    }
    const db = await this.db();
    if (!(await this.tenantExists(tenantId))) return { error: "Tenant not found", status: 404 as const };
    const { rows } = await db.query(
      `INSERT INTO ct_badge (id, tenant_id, holder, type, status, requested_at, valid_until)
       VALUES ($1,$2,$3,$4,'pending',now(),$5) RETURNING ${BADGE_COLS}`,
      [randomUUID(), tenantId, holder, type, validUntil ?? null],
    );
    return { data: (await this.enrichWithTenant(rows))[0], status: 201 as const };
  }

  async updateBadge(id: string, body: Partial<{ holder: string; type: string; status: string; validUntil: string | null }>) {
    const allowed = ["active", "pending", "lost", "pending_deactivation", "deactivated"];
    if (body.status && !allowed.includes(body.status)) {
      return { error: "Invalid status", status: 400 as const };
    }
    const db = await this.db();
    const { rows } = await db.query(
      `UPDATE ct_badge SET
         holder = coalesce($2, holder),
         type = coalesce($3, type),
         status = coalesce($4, status),
         valid_until = coalesce($5, valid_until)
       WHERE id = $1 RETURNING ${BADGE_COLS}`,
      [id, body.holder ?? null, body.type ?? null, body.status ?? null, body.validUntil ?? null],
    );
    if (rows.length === 0) return { error: "Badge not found", status: 404 as const };
    return { data: (await this.enrichWithTenant(rows))[0], status: 200 as const };
  }

  // ── Visitors ───────────────────────────────────────────────────────────

  async getVisitors(status?: string) {
    const db = await this.db();
    const params: unknown[] = [];
    let where = "";
    if (status) { params.push(status); where = "WHERE status = $1"; }
    const { rows } = await db.query(
      `SELECT ${VISITOR_COLS} FROM ct_visitor ${where} ORDER BY coalesce(expected_at, created_at) DESC`,
      params,
    );
    return this.enrichWithTenant(rows);
  }

  async createVisitor(body: {
    tenantId?: string; name?: string; company?: string; email?: string;
    phone?: string; expectedAt?: string; badgeId?: string;
  }) {
    const { tenantId, name, company, email, phone, expectedAt, badgeId } = body;
    if (!name) return { error: "name is required", status: 400 as const };
    const db = await this.db();
    if (tenantId && !(await this.tenantExists(tenantId))) {
      return { error: "Tenant not found", status: 404 as const };
    }
    const { rows } = await db.query(
      `INSERT INTO ct_visitor (id, tenant_id, name, company, email, phone, expected_at, badge_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${VISITOR_COLS}`,
      [randomUUID(), tenantId ?? null, name, company ?? "", email ?? "", phone ?? "", expectedAt ?? null, badgeId ?? null],
    );
    return { data: (await this.enrichWithTenant(rows))[0], status: 201 as const };
  }

  async updateVisitor(id: string, body: Partial<{
    name: string; company: string; email: string; phone: string;
    expectedAt: string; status: string; badgeId: string;
  }>) {
    const allowed = ["expected", "checked_in", "checked_out", "cancelled", "no_show"];
    if (body.status && !allowed.includes(body.status)) {
      return { error: "Invalid status", status: 400 as const };
    }
    const db = await this.db();
    // checked_in / checked_out transitions stamp the matching timestamp.
    const { rows } = await db.query(
      `UPDATE ct_visitor SET
         name = coalesce($2, name),
         company = coalesce($3, company),
         email = coalesce($4, email),
         phone = coalesce($5, phone),
         expected_at = coalesce($6, expected_at),
         status = coalesce($7, status),
         badge_id = coalesce($8, badge_id),
         checked_in_at = CASE WHEN $7 = 'checked_in' THEN now() ELSE checked_in_at END,
         checked_out_at = CASE WHEN $7 = 'checked_out' THEN now() ELSE checked_out_at END
       WHERE id = $1 RETURNING ${VISITOR_COLS}`,
      [id, body.name ?? null, body.company ?? null, body.email ?? null, body.phone ?? null,
        body.expectedAt ?? null, body.status ?? null, body.badgeId ?? null],
    );
    if (rows.length === 0) return { error: "Visitor not found", status: 404 as const };
    return { data: (await this.enrichWithTenant(rows))[0], status: 200 as const };
  }

  // ── Parking ────────────────────────────────────────────────────────────

  async getParkingSpots() {
    const db = await this.db();
    const { rows } = await db.query(
      `SELECT s.number, s.has_charger AS "hasCharger", s.charger_power AS "chargerPower",
              s.charger_price_per_kwh AS "chargerPricePerKwh",
              CASE WHEN EXISTS (
                SELECT 1 FROM ct_parking_reservation r
                WHERE r.spot_number = s.number AND r.status IN ('confirmed','in_progress','overstay')
              ) THEN 'reserved' ELSE 'available' END AS status
       FROM ct_parking_spot s ORDER BY s.number`,
    );
    return rows;
  }

  async getParkingReservations() {
    const db = await this.db();
    const { rows } = await db.query(
      `SELECT ${RESERVATION_COLS} FROM ct_parking_reservation ORDER BY start_time DESC`,
    );
    return this.enrichWithTenant(rows);
  }

  async createParkingReservation(body: {
    spotNumber?: number; tenantId?: string; visitorName?: string;
    startTime?: string; endTime?: string;
  }) {
    const { spotNumber, tenantId, visitorName, startTime, endTime } = body;
    if (!spotNumber || !tenantId || !visitorName || !startTime || !endTime) {
      return { error: "Missing required fields", status: 400 as const };
    }
    const db = await this.db();
    const spot = await db.query(
      `SELECT has_charger AS "hasCharger" FROM ct_parking_spot WHERE number = $1`,
      [spotNumber],
    );
    if (spot.rows.length === 0) return { error: "Spot not found", status: 404 as const };

    const conflict = await db.query(
      `SELECT 1 FROM ct_parking_reservation
       WHERE spot_number = $1 AND status IN ('confirmed','in_progress')
         AND start_time < $3 AND end_time > $2`,
      [spotNumber, startTime, endTime],
    );
    if (conflict.rows.length > 0) {
      return { error: "Spot already reserved for this period", status: 409 as const };
    }

    const { rows } = await db.query(
      `INSERT INTO ct_parking_reservation (id, spot_number, tenant_id, visitor_name, start_time, end_time, status, penalty, charging_kwh)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed',0,$7) RETURNING ${RESERVATION_COLS}`,
      [randomUUID(), spotNumber, tenantId, visitorName, startTime, endTime, spot.rows[0].hasCharger ? 0 : null],
    );
    return { data: (await this.enrichWithTenant(rows))[0], status: 201 as const };
  }

  // ── Tickets ────────────────────────────────────────────────────────────

  async getTickets(status?: string, category?: string, priority?: string) {
    const db = await this.db();
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (category) { params.push(category); where.push(`category = $${params.length}`); }
    if (priority) { params.push(priority); where.push(`priority = $${params.length}`); }
    const { rows } = await db.query(
      `SELECT ${TICKET_COLS} FROM ct_ticket ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at DESC`,
      params,
    );
    return this.enrichWithTenant(rows);
  }

  async createTicket(body: {
    title?: string; tenantId?: string | null; location?: string;
    category?: string; priority?: string;
  }) {
    const { title, tenantId, location, category, priority } = body;
    if (!title || !category) {
      return { error: "title and category are required", status: 400 as const };
    }
    const db = await this.db();
    const { rows } = await db.query(
      `INSERT INTO ct_ticket (id, reference, title, tenant_id, location, category, priority, status, sla_status, assignee)
       VALUES ($1, 'T-' || nextval('ct_ticket_ref'), $2, $3, $4, $5, $6, 'open', 'within', NULL)
       RETURNING ${TICKET_COLS}`,
      [randomUUID(), title, tenantId ?? null, location ?? "", category, priority ?? "standard"],
    );
    return { data: (await this.enrichWithTenant(rows))[0], status: 201 as const };
  }

  async updateTicket(id: string, body: Partial<{
    title: string; location: string; category: string; priority: string;
    status: string; slaStatus: string; assignee: string | null;
  }>) {
    const db = await this.db();
    const { rows } = await db.query(
      `UPDATE ct_ticket SET
         title = coalesce($2, title),
         location = coalesce($3, location),
         category = coalesce($4, category),
         priority = coalesce($5, priority),
         status = coalesce($6, status),
         sla_status = coalesce($7, sla_status),
         assignee = coalesce($8, assignee)
       WHERE id = $1 RETURNING ${TICKET_COLS}`,
      [id, body.title ?? null, body.location ?? null, body.category ?? null,
        body.priority ?? null, body.status ?? null, body.slaStatus ?? null, body.assignee ?? null],
    );
    if (rows.length === 0) return { error: "Ticket not found", status: 404 as const };
    return { data: (await this.enrichWithTenant(rows))[0], status: 200 as const };
  }

  // ── Providers ──────────────────────────────────────────────────────────

  async getProviders() {
    const db = await this.db();
    const { rows } = await db.query(`SELECT ${PROVIDER_COLS} FROM ct_provider ORDER BY name`);
    return rows;
  }

  async createProvider(body: ProviderPayload) {
    const {
      name, service, sla, status, legalName, contractRef, contactName, contactEmail, contactPhone,
      emergencyPhone, address, ice, insuranceExpiry, contractStart, contractEnd, certifications, notes,
    } = body;
    if (!name || !service) return { error: "name and service are required", status: 400 as const };
    const db = await this.db();
    const { rows } = await db.query(
      `INSERT INTO ct_provider (
         id, name, service, sla, status, legal_name, contract_ref, contact_name, contact_email,
         contact_phone, emergency_phone, address, ice, insurance_expiry, contract_start, contract_end,
         certifications, notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING ${PROVIDER_COLS}`,
      [
        randomUUID(), name, service, sla ?? 100, status ?? "active", legalName ?? name, contractRef ?? "",
        contactName ?? "", contactEmail ?? "", contactPhone ?? "", emergencyPhone ?? "", address ?? "",
        ice ?? "", insuranceExpiry ?? null, contractStart ?? null, contractEnd ?? null,
        certifications ?? "", notes ?? "",
      ],
    );
    return { data: rows[0], status: 201 as const };
  }

  async updateProvider(id: string, body: Partial<ProviderPayload>) {
    const db = await this.db();
    const { rows } = await db.query(
      `UPDATE ct_provider SET
         name = coalesce($2, name),
         service = coalesce($3, service),
         sla = coalesce($4, sla),
         status = coalesce($5, status),
         legal_name = coalesce($6, legal_name),
         contract_ref = coalesce($7, contract_ref),
         contact_name = coalesce($8, contact_name),
         contact_email = coalesce($9, contact_email),
         contact_phone = coalesce($10, contact_phone),
         emergency_phone = coalesce($11, emergency_phone),
         address = coalesce($12, address),
         ice = coalesce($13, ice),
         insurance_expiry = coalesce($14, insurance_expiry),
         contract_start = coalesce($15, contract_start),
         contract_end = coalesce($16, contract_end),
         certifications = coalesce($17, certifications),
         notes = coalesce($18, notes)
       WHERE id = $1 RETURNING ${PROVIDER_COLS}`,
      [
        id, body.name ?? null, body.service ?? null, body.sla ?? null, body.status ?? null,
        body.legalName ?? null, body.contractRef ?? null, body.contactName ?? null,
        body.contactEmail ?? null, body.contactPhone ?? null, body.emergencyPhone ?? null,
        body.address ?? null, body.ice ?? null, body.insuranceExpiry ?? null,
        body.contractStart ?? null, body.contractEnd ?? null, body.certifications ?? null,
        body.notes ?? null,
      ],
    );
    if (rows.length === 0) return { error: "Provider not found", status: 404 as const };
    return { data: rows[0], status: 200 as const };
  }

  // ── Back of House elements ─────────────────────────────────────────────

  async getBohElements(category?: string, status?: string) {
    const db = await this.db();
    const where: string[] = [];
    const params: unknown[] = [];
    if (category) { params.push(category); where.push(`category = $${params.length}`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    const { rows } = await db.query(
      `SELECT ${BOH_COLS} FROM ct_boh_element ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY category, name`,
      params,
    );
    return rows;
  }

  async createBohElement(body: {
    name?: string; category?: string; location?: string; status?: string;
    providerId?: string; lastServiceAt?: string; nextServiceAt?: string; notes?: string;
  }) {
    const { name, category, location, status, providerId, lastServiceAt, nextServiceAt, notes } = body;
    if (!name || !category) return { error: "name and category are required", status: 400 as const };
    const db = await this.db();
    const { rows } = await db.query(
      `INSERT INTO ct_boh_element (id, name, category, location, status, provider_id, last_service_at, next_service_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${BOH_COLS}`,
      [randomUUID(), name, category, location ?? "", status ?? "operational",
        providerId ?? null, lastServiceAt ?? null, nextServiceAt ?? null, notes ?? ""],
    );
    return { data: rows[0], status: 201 as const };
  }

  async updateBohElement(id: string, body: Partial<{
    name: string; category: string; location: string; status: string;
    providerId: string; lastServiceAt: string; nextServiceAt: string; notes: string;
  }>) {
    const db = await this.db();
    const { rows } = await db.query(
      `UPDATE ct_boh_element SET
         name = coalesce($2, name),
         category = coalesce($3, category),
         location = coalesce($4, location),
         status = coalesce($5, status),
         provider_id = coalesce($6, provider_id),
         last_service_at = coalesce($7, last_service_at),
         next_service_at = coalesce($8, next_service_at),
         notes = coalesce($9, notes)
       WHERE id = $1 RETURNING ${BOH_COLS}`,
      [id, body.name ?? null, body.category ?? null, body.location ?? null, body.status ?? null,
        body.providerId ?? null, body.lastServiceAt ?? null, body.nextServiceAt ?? null, body.notes ?? null],
    );
    if (rows.length === 0) return { error: "BOH element not found", status: 404 as const };
    return { data: rows[0], status: 200 as const };
  }

  async deleteBohElement(id: string) {
    const db = await this.db();
    const { rowCount } = await db.query("DELETE FROM ct_boh_element WHERE id = $1", [id]);
    if (!rowCount) return { error: "BOH element not found", status: 404 as const };
    return { status: 204 as const };
  }

  // ── Users (better-auth) ────────────────────────────────────────────────

  async getUsers() {
    const db = await this.db();
    const { rows } = await db.query(
      `SELECT id, name, email, "emailVerified", "createdAt" FROM "user" ORDER BY "createdAt" DESC`,
    );
    return rows;
  }

  async createUser(body: { name?: string; email?: string; password?: string }) {
    const { name, email, password } = body;
    if (!email || !password) {
      return { error: "email and password are required", status: 400 as const };
    }
    try {
      const result = await auth.api.signUpEmail({
        body: { name: name ?? email.split("@")[0], email, password },
      });
      return { data: result.user, status: 201 as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-up failed";
      return { error: message, status: 400 as const };
    }
  }

  // ── Calendar ───────────────────────────────────────────────────────────

  async getCalendarEvents() {
    const db = await this.db();
    const { rows } = await db.query(`SELECT ${EVENT_COLS} FROM ct_calendar_event ORDER BY start_time`);
    return rows;
  }

  async createCalendarEvent(body: {
    id?: string; title?: string; description?: string; start?: string;
    end?: string; type?: string; location?: string; agendaId?: string;
  }) {
    const { id, title, description, start, end, type, location, agendaId } = body;
    if (!title || !start || !end) {
      return { error: "title, start, and end are required", status: 400 as const };
    }
    const db = await this.db();
    const { rows } = await db.query(
      `INSERT INTO ct_calendar_event (id, title, description, start_time, end_time, type, location, agenda_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${EVENT_COLS}`,
      [id ?? randomUUID(), title, description ?? "", start, end, type ?? "meeting", location ?? null, agendaId ?? null],
    );
    return { data: rows[0], status: 201 as const };
  }

  async updateCalendarEvent(id: string, body: Partial<{
    title: string; description: string; start: string; end: string;
    type: string; location: string; agendaId: string;
  }>) {
    const db = await this.db();
    const { rows } = await db.query(
      `UPDATE ct_calendar_event SET
         title = coalesce($2, title),
         description = coalesce($3, description),
         start_time = coalesce($4, start_time),
         end_time = coalesce($5, end_time),
         type = coalesce($6, type),
         location = coalesce($7, location),
         agenda_id = coalesce($8, agenda_id)
       WHERE id = $1 RETURNING ${EVENT_COLS}`,
      [id, body.title ?? null, body.description ?? null, body.start ?? null, body.end ?? null,
        body.type ?? null, body.location ?? null, body.agendaId ?? null],
    );
    if (rows.length === 0) return { error: "Event not found", status: 404 as const };
    return { data: rows[0], status: 200 as const };
  }

  async deleteCalendarEvent(id: string) {
    const db = await this.db();
    const { rowCount } = await db.query("DELETE FROM ct_calendar_event WHERE id = $1", [id]);
    if (!rowCount) return { error: "Event not found", status: 404 as const };
    return { status: 204 as const };
  }
}
