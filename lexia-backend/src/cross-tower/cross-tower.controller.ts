import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { CrossTowerService } from "./cross-tower.service";

type ServiceResult<T = unknown> =
  | { error: string; status: 400 | 404 | 409 }
  | { data?: T; status: 200 | 201 | 204 };

function send(res: Response, result: ServiceResult) {
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  if (result.status === 204) return res.status(204).send();
  return res.status(result.status).json(result.data);
}

@ApiTags("Cross Tower")
@Controller()
export class CrossTowerController {
  constructor(private readonly crossTower: CrossTowerService) {}

  @Get("dashboard")
  @ApiOperation({ summary: "Dashboard KPIs, priority tickets, and provider SLA summary" })
  getDashboard() {
    return this.crossTower.getDashboard();
  }

  // ── Tenants ──────────────────────────────────────────────────────────

  @Get("tenants")
  @ApiOperation({ summary: "List tenants" })
  getTenants() {
    return this.crossTower.getTenants();
  }

  @Post("tenants")
  @ApiOperation({ summary: "Create a tenant" })
  async createTenant(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createTenant(body));
  }

  @Patch("tenants/:id")
  @ApiOperation({ summary: "Update a tenant" })
  async updateTenant(@Param("id") id: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.updateTenant(id, body));
  }

  // ── Badges ───────────────────────────────────────────────────────────

  @Get("badges")
  @ApiOperation({ summary: "List badges (optional type/status filters)" })
  getBadges(@Query("type") type?: string, @Query("status") status?: string) {
    return this.crossTower.getBadges(type, status);
  }

  @Post("badges")
  @ApiOperation({ summary: "Create a badge request" })
  async createBadge(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createBadge(body));
  }

  @Patch("badges/:id")
  @ApiOperation({ summary: "Update a badge" })
  async updateBadge(@Param("id") id: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.updateBadge(id, body));
  }

  // ── Visitors ─────────────────────────────────────────────────────────

  @Get("visitors")
  @ApiOperation({ summary: "List visitors (optional status filter)" })
  getVisitors(@Query("status") status?: string) {
    return this.crossTower.getVisitors(status);
  }

  @Post("visitors")
  @ApiOperation({ summary: "Register a visitor" })
  async createVisitor(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createVisitor(body));
  }

  @Patch("visitors/:id")
  @ApiOperation({ summary: "Update a visitor (status: expected/checked_in/checked_out/cancelled/no_show)" })
  async updateVisitor(@Param("id") id: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.updateVisitor(id, body));
  }

  // ── Parking ──────────────────────────────────────────────────────────

  @Get("parking/spots")
  @ApiOperation({ summary: "List parking spots with live availability" })
  getParkingSpots() {
    return this.crossTower.getParkingSpots();
  }

  @Get("parking/reservations")
  @ApiOperation({ summary: "List parking reservations" })
  getParkingReservations() {
    return this.crossTower.getParkingReservations();
  }

  @Post("parking/reservations")
  @ApiOperation({ summary: "Create a parking reservation" })
  async createParkingReservation(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createParkingReservation(body));
  }

  // ── Tickets ──────────────────────────────────────────────────────────

  @Get("tickets")
  @ApiOperation({ summary: "List tickets (optional status/category/priority filters)" })
  getTickets(
    @Query("status") status?: string,
    @Query("category") category?: string,
    @Query("priority") priority?: string,
  ) {
    return this.crossTower.getTickets(status, category, priority);
  }

  @Post("tickets")
  @ApiOperation({ summary: "Create a ticket" })
  async createTicket(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createTicket(body));
  }

  @Patch("tickets/:id")
  @ApiOperation({ summary: "Update a ticket" })
  async updateTicket(@Param("id") id: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.updateTicket(id, body));
  }

  // ── Providers ────────────────────────────────────────────────────────

  @Get("providers")
  @ApiOperation({ summary: "List service providers" })
  getProviders() {
    return this.crossTower.getProviders();
  }

  @Post("providers")
  @ApiOperation({ summary: "Create a service provider" })
  async createProvider(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createProvider(body));
  }

  @Patch("providers/:id")
  @ApiOperation({ summary: "Update a service provider" })
  async updateProvider(@Param("id") id: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.updateProvider(id, body));
  }

  // ── Back of House ────────────────────────────────────────────────────

  @Get("boh")
  @ApiOperation({ summary: "List Back-of-House elements (optional category/status filters)" })
  getBohElements(@Query("category") category?: string, @Query("status") status?: string) {
    return this.crossTower.getBohElements(category, status);
  }

  @Post("boh")
  @ApiOperation({ summary: "Create a Back-of-House element" })
  async createBohElement(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createBohElement(body));
  }

  @Patch("boh/:id")
  @ApiOperation({ summary: "Update a Back-of-House element" })
  async updateBohElement(@Param("id") id: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.updateBohElement(id, body));
  }

  @Delete("boh/:id")
  @ApiOperation({ summary: "Delete a Back-of-House element" })
  async deleteBohElement(@Param("id") id: string, @Res() res: Response) {
    send(res, await this.crossTower.deleteBohElement(id));
  }

  // ── Users ────────────────────────────────────────────────────────────

  @Get("users")
  @ApiOperation({ summary: "List application users (better-auth accounts)" })
  getUsers() {
    return this.crossTower.getUsers();
  }

  @Post("users")
  @ApiOperation({ summary: "Create an application user (email + password)" })
  async createUser(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createUser(body));
  }

  // ── Calendar ─────────────────────────────────────────────────────────

  @Get("calendar/events")
  @ApiOperation({ summary: "List calendar events" })
  getCalendarEvents() {
    return this.crossTower.getCalendarEvents();
  }

  @Post("calendar/events")
  @ApiOperation({ summary: "Create a calendar event" })
  async createCalendarEvent(@Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.createCalendarEvent(body));
  }

  @Patch("calendar/events/:id")
  @ApiOperation({ summary: "Update a calendar event" })
  async updateCalendarEvent(@Param("id") id: string, @Body() body: Record<string, unknown>, @Res() res: Response) {
    send(res, await this.crossTower.updateCalendarEvent(id, body));
  }

  @Delete("calendar/events/:id")
  @ApiOperation({ summary: "Delete a calendar event" })
  async deleteCalendarEvent(@Param("id") id: string, @Res() res: Response) {
    send(res, await this.crossTower.deleteCalendarEvent(id));
  }
}
