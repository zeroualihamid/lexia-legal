import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { KeycloakGuard } from '../../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../../common/guards/access-level.guard';
import { RequireAccessLevel } from '../../../common/decorators/access-level.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(KeycloakGuard, AccessLevelGuard)
@RequireAccessLevel('ADMIN')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Dashboard statistics compatibility endpoint' })
  getStats() {
    return this.analyticsService.getDashboardStats();
  }

  @Get('analytics/overview')
  @ApiOperation({ summary: 'Platform overview statistics' })
  getOverview() {
    return this.analyticsService.getOverview();
  }

  @Get('analytics/realtime')
  @ApiOperation({ summary: 'Real-time platform metrics' })
  getRealtime() {
    return this.analyticsService.getRealtime();
  }

  @Get('analytics/costs')
  @ApiOperation({ summary: 'Usage costs by month' })
  getCosts(@Query('month') month?: string) {
    return this.analyticsService.getCosts(month);
  }

  @Get('analytics/collections')
  @ApiOperation({ summary: 'Document counts per collection' })
  getCollections() {
    return this.analyticsService.getCollections();
  }

  @Get('analytics/report/:month')
  @ApiOperation({ summary: 'Monthly report' })
  getMonthlyReport(@Param('month') month: string) {
    return this.analyticsService.getMonthlyReport(month);
  }
}
