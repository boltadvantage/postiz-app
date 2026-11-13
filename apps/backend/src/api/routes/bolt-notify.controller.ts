// Bolt Advantage: what the browser's desktop notifications need, without the
// side effect of Postiz's own notification list (which marks everything read).
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { DmService } from '@gitroom/nestjs-libraries/bolt-inbox/dm.service';
import { FollowsService } from '@gitroom/nestjs-libraries/bolt-inbox/follows.service';

@ApiTags('Bolt Notify')
@Controller('/bolt-notify')
export class BoltNotifyController {
  constructor(
    private _prisma: PrismaService,
    private _inbox: InboxService,
    private _dms: DmService,
    private _follows: FollowsService
  ) {}

  /** Inbox unread counts, and Postiz notifications (failed posts etc.) newer than `since`. */
  @Get('/feed')
  async feed(@GetOrgFromRequest() org: Organization, @Query('since') since?: string) {
    const after = since && !isNaN(Date.parse(since)) ? new Date(since) : new Date();
    const [items, messages, follows, notifications] = await Promise.all([
      this._inbox.counts(org.id),
      this._dms.unreadCount(org.id),
      this._follows.unreadCount(org.id),
      this._prisma.notifications.findMany({
        where: { organizationId: org.id, deletedAt: null, createdAt: { gt: after } },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, content: true, createdAt: true },
      }),
    ]);
    return { now: new Date().toISOString(), mentions: items.unread, messages, follows, notifications };
  }
}
