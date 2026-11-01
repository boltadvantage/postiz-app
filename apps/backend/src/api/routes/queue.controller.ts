// Bolt Advantage: posting queues (per-weekday times per channel).
import { Body, Controller, Get, HttpException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { QueueService } from '@gitroom/nestjs-libraries/bolt-queue/queue.service';
import { PauseService } from '@gitroom/nestjs-libraries/bolt-queue/pause.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { isValidTimeZone } from '@gitroom/nestjs-libraries/bolt-queue/slots';

@ApiTags('Queue')
@Controller('/queue')
export class QueueController {
  constructor(
    private _queue: QueueService,
    private _pause: PauseService,
    private _posts: PostsService
  ) {}

  @Get('/')
  list(@GetOrgFromRequest() org: Organization) {
    return this._queue.list(org.id);
  }

  // declared before the /:integrationId routes so "pause" isn't read as an id
  @Get('/pause')
  pauseStatus(@GetOrgFromRequest() org: Organization) {
    return this._pause.status(org.id);
  }

  /** Pause stops every scheduled post now; resume restarts them (missed ones go into the queue). */
  @Put('/pause')
  async setPause(@GetOrgFromRequest() org: Organization, @Body() body: { paused?: boolean }) {
    if (body?.paused) {
      return { paused: true, ...(await this._pause.pause(org.id)) };
    }
    return { paused: false, ...(await this._posts.resumePosting(org.id)) };
  }

  @Put('/:integrationId/days-off')
  async daysOff(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: { daysOff?: unknown; timeZone?: string }
  ) {
    try {
      return await this._queue.setDaysOff(org.id, integrationId, body?.daysOff, body?.timeZone);
    } catch (e: any) {
      throw new HttpException(e.message, 400);
    }
  }

  @Post('/:integrationId/auto-pick')
  async autoPick(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: { perDay?: unknown }
  ) {
    try {
      return await this._queue.autoPick(org.id, integrationId, body?.perDay);
    } catch (e: any) {
      throw new HttpException(e.message, 400);
    }
  }

  @Put('/:integrationId')
  async save(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: { timeZone?: string; slots?: unknown; paused?: boolean; daysOff?: unknown; perDay?: unknown; autoAdjust?: boolean }
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
