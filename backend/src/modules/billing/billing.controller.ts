import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { BillingService } from './billing.service';
import { KeycloakGuard } from '../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../common/decorators/access-level.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/guards/keycloak.guard';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('billing')
@UseGuards(KeycloakGuard, AccessLevelGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'Get all subscription plans' })
  async getPlans() {
    return this.billingService.getPlans();
  }

  @Get('subscription')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Get my subscription' })
  async getMySubscription(@CurrentUser() user: AuthUser) {
    return this.billingService.getMySubscription(user.userId);
  }

  @Post('subscription')
  @ApiOperation({ summary: 'Subscribe to a plan' })
  async subscribe(
    @Body() body: { planId: string; paymentMethod: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.billingService.subscribe(user.userId, body.planId, body.paymentMethod);
  }

  @Delete('subscription')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Cancel subscription' })
  async cancelSubscription(@CurrentUser() user: AuthUser) {
    await this.billingService.cancelSubscription(user.userId);
    return { success: true };
  }

  @Patch('subscription/auto-renew')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Toggle auto-renew' })
  async toggleAutoRenew(
    @Body('autoRenew') autoRenew: boolean,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billingService.toggleAutoRenew(user.userId, autoRenew);
  }

  @Get('usage')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Get current usage' })
  async getCurrentUsage(@CurrentUser() user: AuthUser) {
    return this.billingService.getCurrentUsage(user.userId);
  }

  @Get('usage/history')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Get usage history' })
  async getUsageHistory(@CurrentUser() user: AuthUser) {
    return this.billingService.getUsageHistory(user.userId);
  }

  @Get('invoices')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Get invoices' })
  async getInvoices(@CurrentUser() user: AuthUser) {
    return this.billingService.getInvoices(user.userId);
  }

  @Get('invoices/:id/pdf')
  @RequireAccessLevel('PRO')
  @ApiOperation({ summary: 'Download invoice PDF' })
  async getInvoicePdf(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.billingService.getInvoicePdf(user.userId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${id}.pdf`);
    res.send(buffer);
  }

  @Get('admin/overview')
  @RequireAccessLevel('ADMIN')
  @ApiOperation({ summary: 'Admin billing overview' })
  async adminOverview() {
    return this.billingService.adminOverview();
  }
}
