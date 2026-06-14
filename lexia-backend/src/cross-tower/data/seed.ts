import { randomUUID } from "node:crypto";

const id = () => randomUUID();

export interface Tenant {
  id: string;
  name: string;
  floor: number;
  contactEmail: string;
  employees: number;
}

export interface Badge {
  id: string;
  tenantId: string;
  holder: string;
  type: string;
  status: string;
  requestedAt: string;
  validUntil: string | null;
}

export interface ParkingSpot {
  number: number;
  hasCharger: boolean;
  chargerPower: number | null;
  chargerPricePerKwh: number | null;
}

export interface ParkingReservation {
  id: string;
  spotNumber: number;
  tenantId: string;
  visitorName: string;
  startTime: string;
  endTime: string;
  status: string;
  penalty: number;
  chargingKwh?: number | null;
}

export interface Ticket {
  id: string;
  reference: string;
  title: string;
  tenantId: string | null;
  location: string;
  category: string;
  priority: string;
  status: string;
  slaStatus: string;
  createdAt: string;
  assignee: string | null;
}

export interface Provider {
  id: string;
  name: string;
  service: string;
  sla: number;
  status: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  type: string;
  location?: string;
  agendaId?: string;
}

export const tenants: Tenant[] = [
  { id: id(), name: "Atlas Capital", floor: 14, contactEmail: "admin@atlas-capital.ma", employees: 42 },
  { id: id(), name: "Cabinet Tazi & Co.", floor: 9, contactEmail: "contact@tazi-co.ma", employees: 18 },
  { id: id(), name: "SARL Belmedia", floor: 7, contactEmail: "rh@belmedia.ma", employees: 28 },
  { id: id(), name: "Deloitte Maroc", floor: 17, contactEmail: "admin@deloitte.ma", employees: 65 },
  { id: id(), name: "Wafa Assurance", floor: 11, contactEmail: "office@wafa.ma", employees: 31 },
];

export const badges: Badge[] = [
  { id: id(), tenantId: tenants[0].id, holder: "Karim Bennani", type: "permanent", status: "active", requestedAt: "2026-04-22T08:30:00Z", validUntil: null },
  { id: id(), tenantId: tenants[0].id, holder: "Sara Idrissi", type: "permanent", status: "pending", requestedAt: "2026-04-29T07:15:00Z", validUntil: null },
  { id: id(), tenantId: tenants[1].id, holder: "Mehdi Alaoui (Deloitte)", type: "visitor", status: "active", requestedAt: "2026-04-29T09:00:00Z", validUntil: "2026-04-29T16:00:00Z" },
  { id: id(), tenantId: tenants[2].id, holder: "3 prestataires IT", type: "personal", status: "pending", requestedAt: "2026-04-28T14:20:00Z", validUntil: "2026-07-28T18:00:00Z" },
  { id: id(), tenantId: tenants[0].id, holder: "Younes Lahlou", type: "permanent", status: "lost", requestedAt: "2026-04-27T10:00:00Z", validUntil: null },
  { id: id(), tenantId: tenants[3].id, holder: "Amal Saidi", type: "permanent", status: "pending_deactivation", requestedAt: "2026-04-29T08:00:00Z", validUntil: null },
  { id: id(), tenantId: tenants[4].id, holder: "Rachid El Fassi", type: "permanent", status: "active", requestedAt: "2026-04-15T11:30:00Z", validUntil: null },
  { id: id(), tenantId: tenants[1].id, holder: "Auditeurs KPMG (4 pers.)", type: "visitor", status: "pending", requestedAt: "2026-04-29T06:45:00Z", validUntil: "2026-04-30T18:00:00Z" },
];

const totalSpots = 20;
export const parkingSpots: ParkingSpot[] = Array.from({ length: totalSpots }, (_, i) => {
  const number = i + 1;
  const hasCharger = number > 10;
  return {
    number,
    hasCharger,
    chargerPower: hasCharger ? 22 : null,
    chargerPricePerKwh: hasCharger ? 12 : null,
  };
});

const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
export const parkingReservations: ParkingReservation[] = [
  { id: id(), spotNumber: 2, tenantId: tenants[0].id, visitorName: "Hamza Berrada", startTime: `${todayStr}T09:00:00Z`, endTime: `${todayStr}T11:00:00Z`, status: "completed", penalty: 0 },
  { id: id(), spotNumber: 5, tenantId: tenants[3].id, visitorName: "Leila Chami", startTime: `${todayStr}T10:00:00Z`, endTime: `${todayStr}T13:30:00Z`, status: "overstay", penalty: 100 },
  { id: id(), spotNumber: 8, tenantId: tenants[1].id, visitorName: "Réda Bouazza", startTime: `${todayStr}T11:00:00Z`, endTime: `${todayStr}T13:00:00Z`, status: "in_progress", penalty: 0 },
  { id: id(), spotNumber: 13, tenantId: tenants[0].id, visitorName: "Mehdi Alaoui", startTime: `${todayStr}T14:00:00Z`, endTime: `${todayStr}T16:00:00Z`, status: "confirmed", penalty: 0, chargingKwh: null },
  { id: id(), spotNumber: 17, tenantId: tenants[4].id, visitorName: "Karima Idrissi", startTime: `${todayStr}T15:00:00Z`, endTime: `${todayStr}T17:00:00Z`, status: "confirmed", penalty: 0, chargingKwh: 18 },
];

export const tickets: Ticket[] = [
  { id: id(), reference: "T-1247", title: "Climatisation HS — bureaux Atlas", tenantId: tenants[0].id, location: "Étage 14 — zone B", category: "maintenance", priority: "critical", status: "open", slaStatus: "breached", createdAt: "2026-04-29T08:25:00Z", assignee: "ClimaTech" },
  { id: id(), reference: "T-1246", title: "Ascenseur n°2 — bruit anormal", tenantId: null, location: "Hall principal", category: "maintenance", priority: "high", status: "in_progress", slaStatus: "within", createdAt: "2026-04-29T07:00:00Z", assignee: "Schindler" },
  { id: id(), reference: "T-1245", title: "Désinsectisation parties communes", tenantId: null, location: "Sous-sol & RDC", category: "hygiene_3d", priority: "standard", status: "scheduled", slaStatus: "within", createdAt: "2026-04-28T10:00:00Z", assignee: "Hygia Maroc" },
  { id: id(), reference: "T-1244", title: "Borne recharge P-15 — fault détecté", tenantId: null, location: "Parking N-1", category: "maintenance", priority: "high", status: "open", slaStatus: "within", createdAt: "2026-04-29T01:00:00Z", assignee: "ChargePoint MA" },
  { id: id(), reference: "T-1243", title: "Nettoyage vitres façade", tenantId: null, location: "Façade nord", category: "cleaning", priority: "standard", status: "scheduled", slaStatus: "within", createdAt: "2026-04-25T09:00:00Z", assignee: "CleanProMa" },
  { id: id(), reference: "T-1242", title: "Demande badge personnel (3 prestataires IT)", tenantId: tenants[2].id, location: "Étage 7", category: "badge_request", priority: "standard", status: "open", slaStatus: "within", createdAt: "2026-04-28T14:20:00Z", assignee: "Accueil" },
  { id: id(), reference: "T-1241", title: "Réservation business lounge — meeting board", tenantId: tenants[1].id, location: "Salle Atlas", category: "amenity_booking", priority: "standard", status: "resolved", slaStatus: "within", createdAt: "2026-04-27T11:30:00Z", assignee: "Accueil" },
];

const calendarWeekStart = new Date();
calendarWeekStart.setHours(0, 0, 0, 0);
const dayOffset = calendarWeekStart.getDay() === 0 ? -6 : 1 - calendarWeekStart.getDay();
calendarWeekStart.setDate(calendarWeekStart.getDate() + dayOffset);

function calendarSlot(dayIndex: number, startHour: number, durationHours: number) {
  const start = new Date(calendarWeekStart);
  start.setDate(start.getDate() + dayIndex);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(start.getHours() + durationHours);
  return { start: start.toISOString(), end: end.toISOString() };
}

export const calendarEvents: CalendarEvent[] = [
  {
    id: id(),
    title: "Inspection climatisation — Atlas Capital",
    description: "Contrôle unités VRV étage 14",
    ...calendarSlot(0, 9, 2),
    type: "maintenance",
    location: "Étage 14 — zone B",
  },
  {
    id: id(),
    title: "Réunion property committee",
    description: "Revue SLA prestataires et incidents du mois",
    ...calendarSlot(1, 10, 1),
    type: "meeting",
    location: "Salle Atlas",
  },
  {
    id: id(),
    title: "Désinsectisation sous-sol",
    description: "Intervention Hygia Maroc — T-1245",
    ...calendarSlot(2, 8, 3),
    type: "maintenance",
    location: "Sous-sol & RDC",
  },
  {
    id: id(),
    title: "Visite Deloitte — audit sécurité",
    description: "Walkthrough avec Securitas",
    ...calendarSlot(3, 14, 2),
    type: "visit",
    location: "Hall principal",
  },
  {
    id: id(),
    title: "Maintenance borne P-15",
    description: "ChargePoint MA — diagnostic fault",
    ...calendarSlot(4, 11, 2),
    type: "maintenance",
    location: "Parking N-1",
  },
];

export const providers: Provider[] = [
  { id: id(), name: "CleanProMa", service: "cleaning", sla: 96, status: "active" },
  { id: id(), name: "Securitas", service: "security", sla: 100, status: "active" },
  { id: id(), name: "Hygia Maroc", service: "hygiene_3d", sla: 82, status: "active" },
  { id: id(), name: "ClimaTech", service: "maintenance", sla: 71, status: "active" },
  { id: id(), name: "Schindler", service: "maintenance", sla: 94, status: "active" },
  { id: id(), name: "ChargePoint MA", service: "maintenance", sla: 88, status: "active" },
];

export function dashboardKpi() {
  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const visitorsToday = badges.filter((b) => b.type === "visitor" && b.requestedAt.startsWith(todayDate)).length + 39;
  const parkingOccupied = parkingReservations.filter((r) => ["confirmed", "in_progress", "overstay"].includes(r.status)).length;
  const overstays = parkingReservations.filter((r) => r.status === "overstay").length;
  const openTickets = tickets.filter((t) => ["open", "in_progress"].includes(t.status)).length;
  const slaBreached = tickets.filter((t) => t.slaStatus === "breached").length;
  const activeBadges = badges.filter((b) => b.status === "active").length + 1239;
  const newBadgesWeek = 8;
  const revenue = {
    badges: 12400,
    parkingPenalties: parkingReservations.filter((r) => r.status === "overstay").length * 100 + 3100,
    chargingStations: 8750,
  };

  return {
    visitorsToday,
    visitorsExpected: 12,
    parkingOccupied,
    parkingTotal: 20,
    overstays,
    openTickets,
    slaBreached,
    activeBadges,
    newBadgesWeek,
    revenue,
  };
}
