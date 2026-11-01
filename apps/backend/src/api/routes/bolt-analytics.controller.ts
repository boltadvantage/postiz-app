// Bolt Advantage: saved analytics (history, top posts, best times, CSV).
import { Controller, Get, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { BoltAnalyticsService } from '@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.service';
import { BoltAnalyticsQueries } from '@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.queries';

const clampDays = (v: string | undefined, fallback: number) =>
  Math.min(365, Math.max(1, Number(v) || fallback));

const validZone = (tz: string | null | undefined) => {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
};

@ApiTags('Analytics')
@Controller('/bolt-analytics')
export class BoltAnalyticsController {
  constructor(
    private _service: BoltAnalyticsService,
    private _queries: BoltAnalyticsQueries
  ) {}

  @Get('/status')
  async status(@GetOrgFromRequest() org: Organization) {
    return this._queries.status(org.id, await this._service.isRunning());
  }

  /** Starts a sync for this organization in the background. */
  @Post('/sync')
  async sync(@GetOrgFromRequest() org: Organization) {
    if (await this._service.isRunning()) {
      return { started: false, running: true };
    }
    this._service.syncAll(org.id).catch(() => undefined);
    return { started: true };
  }

  @Get('/summary')
  summary(@GetOrgFromRequest() org: Organization, @Query('days') days?: string) {
    return this._queries.summary(org.id, clampDays(days, 30));
  }

  @Get('/posts')
  posts(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationId') integrationId?: string,
    @Query('days') days?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string
  ) {
    return this._queries.posts(org.id, {
      integrationId: integrationId || undefined,
      days: clampDays(days, 90),
      sort: sort === 'date' || sort === 'impressions' ? sort : 'engagement',
      page: Math.max(0, Number(page) || 0),
    });
  }

  @Get('/best-times')
  bestTimes(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Query('integrationId') integrationId?: string,
    @Query('timeZone') timeZone?: string
  ) {
    return this._queries.bestTimes(org.id, integrationId || undefined, validZone(timeZone || user.timezoneName));
  }

  @Get('/export.csv')
  async csv(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days: string | undefined,
    @Res() res: Response
  ) {
    const body = await this._queries.csv(org.id, clampDays(days, 90));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="postiz-analytics-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(body);
  }
}
