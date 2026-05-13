import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { KeycloakGuard } from '../../common/guards/keycloak.guard';
import { AccessLevelGuard } from '../../common/guards/access-level.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/guards/keycloak.guard';

@ApiTags('Search')
@ApiBearerAuth()
@Controller('search')
@UseGuards(KeycloakGuard, AccessLevelGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Search legal documents' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'collection', required: false })
  @ApiQuery({ name: 'mode', required: false, enum: ['hybrid', 'semantic', 'fulltext'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async search(
    @Query('q') query: string,
    @Query('collection') collection?: string,
    @Query('mode') mode: string = 'hybrid',
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.searchService.search(query, collection, mode, +page, +limit, user);
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Autocomplete suggestions' })
  @ApiQuery({ name: 'q', required: true })
  async suggest(@Query('q') query: string) {
    return this.searchService.suggest(query);
  }

  @Get('document/:id')
  @ApiOperation({ summary: 'Get document detail' })
  async getDocument(
    @Param('id') id: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.searchService.getDocument(id, user);
  }
}
