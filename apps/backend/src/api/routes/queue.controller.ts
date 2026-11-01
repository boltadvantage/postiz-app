// Bolt Advantage: posting queues (per-weekday times per channel).
import { Body, Controller, Get, HttpException, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { QueueService } from '@gitroom/nestjs-libraries/bolt-queue/queue.service';
import { isValidTimeZone } from '@gitroom/nestjs-libraries/bolt-queue/slots';

@ApiTags('Queue')
@Controller('/queue')
export class QueueController {
  constructor(private _queue: QueueService) {}

  @Get('/')
  list(@GetOrgFromRequest() org: Organization) {
    return this._queue.list(org.id);
  }

  @Put('/:integrationId')
  async save(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: { timeZone?: string; slots?: unknown; paused?: boolean }
  ) {
    try {
      return await this._queue.save(org.id, integrationId, body || {});
    } catch (e: any) {
      throw new HttpException(e.message, 400);
    }
  }

  @Get('/:integrationId/suggestions')
  suggestions(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('integrationId') integrationId: string,
    @Query('timeZone') timeZone?: string
  ) {
    const tz = [timeZone, user.timezoneName, 'UTC'].find((z) => z && isValidTimeZone(z))!;
    return this._queue.suggestions(org.id, integrationId, tz);
  }

  @Get('/:integrationId/next')
  async next(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Query('count') count?: string
  ) {
    const n = Math.min(20, Math.max(1, Number(count) || 1));
    return { dates: (await this._queue.next(org.id, integrationId, n)) || [] };
  }
}
