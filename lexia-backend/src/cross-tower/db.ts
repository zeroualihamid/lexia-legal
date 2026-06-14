import { Pool } from "pg";
import { pool } from "../auth";
import {
  badges,
  calendarEvents,
  parkingReservations,
  parkingSpots,
  providers,
  tenants,
  tickets,
} from "./data/seed";

/**
 * Cross-Tower persistence: building-management tables in the same Postgres
 * instance better-auth uses (container `brikz-cross-postgres`).
 *
 * All ids are TEXT (UUID strings generated app-side) so client-supplied ids
 * (e.g. CalSync event ids) never fail a uuid cast. Schema creation is
 * idempotent and runs at module init; seed data is inserted only when the
 * tenants table is empty (first boot).
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ct_tenant (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  floor         INT  NOT NULL DEFAULT 0,
  office_number TEXT NOT NULL DEFAULT '',
  legal_name    TEXT NOT NULL DEFAULT '',
  activity      TEXT NOT NULL DEFAULT '',
  registration_number TEXT NOT NULL DEFAULT '',
  ice           TEXT NOT NULL DEFAULT '',
  tax_id        TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_name  TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL DEFAULT '',
  emergency_contact TEXT NOT NULL DEFAULT '',
  lease_start   DATE,
  lease_end     DATE,
  area_sqm      INT,
  website       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  notes         TEXT NOT NULL DEFAULT '',
  employees     INT  NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ct_badge (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT REFERENCES ct_tenant(id) ON DELETE SET NULL,
  holder       TEXT NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ct_visitor (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT REFERENCES ct_tenant(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  company        TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  expected_at    TIMESTAMPTZ,
  checked_in_at  TIMESTAMPTZ,
  checked_out_at TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'expected',
  badge_id       TEXT REFERENCES ct_badge(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ct_parking_spot (
  number                INT PRIMARY KEY,
  has_charger           BOOLEAN NOT NULL DEFAULT false,
  charger_power         INT,
  charger_price_per_kwh INT
);

CREATE TABLE IF NOT EXISTS ct_parking_reservation (
  id           TEXT PRIMARY KEY,
  spot_number  INT NOT NULL REFERENCES ct_parking_spot(number),
  tenant_id    TEXT REFERENCES ct_tenant(id) ON DELETE SET NULL,
  visitor_name TEXT NOT NULL,
  start_time   TIMESTAMPTZ NOT NULL,
  end_time     TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'confirmed',
  penalty      INT NOT NULL DEFAULT 0,
  charging_kwh INT
);

CREATE SEQUENCE IF NOT EXISTS ct_ticket_ref START 1248;

CREATE TABLE IF NOT EXISTS ct_ticket (
  id         TEXT PRIMARY KEY,
  reference  TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  tenant_id  TEXT REFERENCES ct_tenant(id) ON DELETE SET NULL,
  location   TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL,
  priority   TEXT NOT NULL DEFAULT 'standard',
  status     TEXT NOT NULL DEFAULT 'open',
  sla_status TEXT NOT NULL DEFAULT 'within',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assignee   TEXT
);

CREATE TABLE IF NOT EXISTS ct_provider (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  service         TEXT NOT NULL,
  sla             INT  NOT NULL DEFAULT 100,
  status          TEXT NOT NULL DEFAULT 'active',
  legal_name      TEXT NOT NULL DEFAULT '',
  contract_ref    TEXT NOT NULL DEFAULT '',
  contact_name    TEXT NOT NULL DEFAULT '',
  contact_email   TEXT NOT NULL DEFAULT '',
  contact_phone   TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  ice             TEXT NOT NULL DEFAULT '',
  insurance_expiry DATE,
  contract_start  DATE,
  contract_end    DATE,
  certifications  TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ct_calendar_event (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,
  type        TEXT NOT NULL DEFAULT 'meeting',
  location    TEXT,
  agenda_id   TEXT
);

-- Back of House: technical/operational assets of the building (HVAC, lifts,
-- loading docks, storage rooms, electrical boards, …)
CREATE TABLE IF NOT EXISTS ct_boh_element (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  location        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'operational',
  provider_id     TEXT REFERENCES ct_provider(id) ON DELETE SET NULL,
  last_service_at TIMESTAMPTZ,
  next_service_at TIMESTAMPTZ,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_badge_tenant ON ct_badge(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ct_visitor_tenant ON ct_visitor(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ct_reservation_spot ON ct_parking_reservation(spot_number);
CREATE INDEX IF NOT EXISTS idx_ct_ticket_status ON ct_ticket(status);
CREATE INDEX IF NOT EXISTS idx_ct_event_start ON ct_calendar_event(start_time);

-- Idempotent enrichments for databases created before the signaletic sheets.
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS office_number TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS legal_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS activity TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS registration_number TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS ice TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS billing_email TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS emergency_contact TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS lease_start DATE;
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS lease_end DATE;
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS area_sqm INT;
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS website TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE ct_tenant ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS legal_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS contract_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS contact_email TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS contact_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS emergency_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS ice TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS insurance_expiry DATE;
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS contract_start DATE;
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS contract_end DATE;
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS certifications TEXT NOT NULL DEFAULT '';
ALTER TABLE ct_provider ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
`;

async function seedIfEmpty(db: Pool): Promise<void> {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM ct_tenant");
  if (rows[0].n > 0) return;

  for (const t of tenants) {
    await db.query(
      "INSERT INTO ct_tenant (id, name, floor, contact_email, employees) VALUES ($1,$2,$3,$4,$5)",
      [t.id, t.name, t.floor, t.contactEmail, t.employees],
    );
  }
  for (const b of badges) {
    await db.query(
      "INSERT INTO ct_badge (id, tenant_id, holder, type, status, requested_at, valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [b.id, b.tenantId, b.holder, b.type, b.status, b.requestedAt, b.validUntil],
    );
  }
  for (const s of parkingSpots) {
    await db.query(
      "INSERT INTO ct_parking_spot (number, has_charger, charger_power, charger_price_per_kwh) VALUES ($1,$2,$3,$4) ON CONFLICT (number) DO NOTHING",
      [s.number, s.hasCharger, s.chargerPower, s.chargerPricePerKwh],
    );
  }
  for (const r of parkingReservations) {
    await db.query(
      "INSERT INTO ct_parking_reservation (id, spot_number, tenant_id, visitor_name, start_time, end_time, status, penalty, charging_kwh) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [r.id, r.spotNumber, r.tenantId, r.visitorName, r.startTime, r.endTime, r.status, r.penalty, r.chargingKwh ?? null],
    );
  }
  for (const t of tickets) {
    await db.query(
      "INSERT INTO ct_ticket (id, reference, title, tenant_id, location, category, priority, status, sla_status, created_at, assignee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [t.id, t.reference, t.title, t.tenantId, t.location, t.category, t.priority, t.status, t.slaStatus, t.createdAt, t.assignee],
    );
  }
  for (const p of providers) {
    await db.query(
      "INSERT INTO ct_provider (id, name, service, sla, status) VALUES ($1,$2,$3,$4,$5)",
      [p.id, p.name, p.service, p.sla, p.status],
    );
  }
  for (const e of calendarEvents) {
    await db.query(
      "INSERT INTO ct_calendar_event (id, title, description, start_time, end_time, type, location, agenda_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [e.id, e.title, e.description, e.start, e.end, e.type, e.location ?? null, e.agendaId ?? null],
    );
  }
}

async function enrichSignaleticDefaults(db: Pool): Promise<void> {
  await db.query(`
    UPDATE ct_tenant SET
      office_number = CASE name
        WHEN 'Deloitte Maroc' THEN 'B-1701'
        WHEN 'Atlas Capital' THEN 'A-1402'
        WHEN 'Wafa Assurance' THEN 'A-1101'
        WHEN 'Cabinet Tazi & Co.' THEN 'B-0904'
        WHEN 'SARL Belmedia' THEN 'A-0703'
        ELSE coalesce(nullif(office_number, ''), 'À compléter')
      END,
      legal_name = coalesce(nullif(legal_name, ''), name),
      activity = CASE name
        WHEN 'Deloitte Maroc' THEN 'Conseil, audit et risk advisory'
        WHEN 'Atlas Capital' THEN 'Gestion d’actifs et investment office'
        WHEN 'Wafa Assurance' THEN 'Assurance et services financiers'
        WHEN 'Cabinet Tazi & Co.' THEN 'Cabinet d’avocats d’affaires'
        WHEN 'SARL Belmedia' THEN 'Média, production et communication'
        ELSE coalesce(nullif(activity, ''), 'À compléter')
      END,
      registration_number = coalesce(nullif(registration_number, ''), 'RC-' || upper(substr(id, 1, 8))),
      ice = coalesce(nullif(ice, ''), 'ICE-' || upper(substr(id, 10, 8))),
      tax_id = coalesce(nullif(tax_id, ''), 'IF-' || upper(substr(id, 19, 6))),
      contact_name = coalesce(nullif(contact_name, ''), 'Responsable facilities'),
      contact_phone = coalesce(nullif(contact_phone, ''), '+212 522 00 00 00'),
      billing_email = coalesce(nullif(billing_email, ''), contact_email),
      emergency_contact = coalesce(nullif(emergency_contact, ''), 'Standard sécurité +212 522 99 99 99'),
      lease_start = coalesce(lease_start, DATE '2024-01-01'),
      lease_end = coalesce(lease_end, DATE '2027-12-31'),
      area_sqm = coalesce(area_sqm, greatest(employees * 12, 180)),
      website = coalesce(nullif(website, ''), 'https://www.example.com'),
      status = coalesce(nullif(status, ''), 'active')
    WHERE office_number = '' OR legal_name = '' OR activity = '' OR area_sqm IS NULL;

    UPDATE ct_provider SET
      legal_name = coalesce(nullif(legal_name, ''), name),
      contract_ref = coalesce(nullif(contract_ref, ''), 'CT-FM-' || upper(substr(id, 1, 6))),
      contact_name = coalesce(nullif(contact_name, ''), 'Responsable compte'),
      contact_email = coalesce(nullif(contact_email, ''), lower(replace(name, ' ', '.')) || '@example.com'),
      contact_phone = coalesce(nullif(contact_phone, ''), '+212 522 10 10 10'),
      emergency_phone = coalesce(nullif(emergency_phone, ''), '+212 661 00 00 00'),
      address = coalesce(nullif(address, ''), 'Casablanca, Maroc'),
      ice = coalesce(nullif(ice, ''), 'ICE-' || upper(substr(id, 10, 8))),
      insurance_expiry = coalesce(insurance_expiry, DATE '2026-12-31'),
      contract_start = coalesce(contract_start, DATE '2025-01-01'),
      contract_end = coalesce(contract_end, DATE '2027-12-31'),
      certifications = coalesce(nullif(certifications, ''), 'Attestation assurance RC, habilitations site'),
      notes = coalesce(nullif(notes, ''), 'Fiche signalétique à maintenir à jour après revue contractuelle.')
    WHERE legal_name = '' OR contract_ref = '' OR contact_email = '';
  `);
}

let ready: Promise<void> | null = null;

/** Idempotent schema creation + first-boot seed. Safe to call concurrently. */
export function ensureCrossTowerSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(SCHEMA_SQL);
      await seedIfEmpty(pool);
      await enrichSignaleticDefaults(pool);
    })();
  }
  return ready;
}

export { pool };
