import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { PostgresService } from '../../database/postgres.service';

export const USAGE_TYPE_KEY = 'usageType';

export type UsageType = 'message' | 'search';

export const TrackUsage = (type: UsageType) =>
  (target: any, key: string, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(USAGE_TYPE_KEY, type, descriptor.value);
    return descriptor;
  };

@Injectable()
export class UsageTrackingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UsageTrackingInterceptor.name);

  constructor(
    private readonly postgresService: PostgresService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      tap(async () => {
        try {
          const request = context.switchToHttp().getRequest();
          const user = request.user;

          if (!user || !user.userId) return;

          const usageType = this.reflector.get<UsageType>(
            USAGE_TYPE_KEY,
            context.getHandler(),
          );

          if (!usageType) return;

          const now = new Date();
          const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

          if (usageType === 'message') {
            await this.postgresService.query(
              `INSERT INTO usage_records (user_id, month, messages_count, searches_count)
               VALUES ($1, $2, 1, 0)
               ON CONFLICT (user_id, month)
               DO UPDATE SET messages_count = usage_records.messages_count + 1`,
              [user.userId, month],
            );
          } else if (usageType === 'search') {
            await this.postgresService.query(
              `INSERT INTO usage_records (user_id, month, messages_count, searches_count)
               VALUES ($1, $2, 0, 1)
               ON CONFLICT (user_id, month)
               DO UPDATE SET searches_count = usage_records.searches_count + 1`,
              [user.userId, month],
            );
          }
        } catch (err) {
          this.logger.error(`Usage tracking failed: ${err.message}`);
        }
      }),
    );
  }
}
