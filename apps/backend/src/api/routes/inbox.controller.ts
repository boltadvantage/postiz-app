// Bolt Advantage: the inbox (mentions, replies, quotes, direct messages) with private people tags and mutes.
import { Body, Controller, Get, HttpException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { INBOX_ACTIONS, InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { DmService } from '@gitroom/nestjs-libraries/bolt-inbox/dm.service';
import { inboxSwitches, setInboxSwitch } from '@gitroom/nestjs-libraries/bolt-inbox/switches';
import { FollowsService } from '@gitroom/nestjs-libraries/bolt-inbox/follows.service';
import { FOLLOW_PLATFORMS, saveFollowSetting } from '@gitroom/nestjs-libraries/bolt-inbox/follows';
import { requireOrgAdmin } from '@gitroom/nestjs-libraries/user/require.org.admin';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const wrap = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e: any) {
    throw new HttpException(e?.message || 'Something went wrong', 400);
  }
};

@ApiTags('Inbox')
@Controller('/inbox')
export class InboxController {
  constructor(
    private _inbox: InboxService,
    private _dms: DmService,
    private _prisma: PrismaService,
    private _follows: FollowsService
  ) {}

  private ids = (body: { ids?: unknown }) => {
    if (!Array.isArray(body?.ids)) throw new HttpException('Bad request', 400);
    return body.ids.map(String);
  };

  /** Which channels have mentions or messages switched off. */
  @Get('/switches')
  switches(@GetOrgFromRequest() org: Organization) {
    return inboxSwitches(this._prisma, org.id);
  }

  @Put('/switches/:id')
  async setSwitch(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: { mentions?: boolean; messages?: boolean }) {
    requireOrgAdmin(org);
    const channel = await this._prisma.integration.findFirst({ where: { id, organizationId: org.id, deletedAt: null }, select: { id: true } });
    if (!channel) throw new HttpException('Channel not found', 404);
    let next = await inboxSwitches(this._prisma, org.id);
    if (typeof body?.mentions === 'boolean') next = await setInboxSwitch(this._prisma, org.id, id, 'mentions', body.mentions);
    if (typeof body?.messages === 'boolean') next = await setInboxSwitch(this._prisma, org.id, id, 'messages', body.messages);
    return next;
  }

  @Get('/')
  items(
    @GetOrgFromRequest() org: Organization,
    @Query('channels') channels?: string,
    @Query('kinds') kinds?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    @Query('showMuted') showMuted?: string,
    @Query('q') q?: string,
    @Query('page') page?: string
  ) {
    return this._inbox.list(org.id, {
      integrationIds: list(channels),
      kinds: list(kinds)?.filter((k) => ['mention', 'reply', 'quote'].includes(k)) as any,
      status: (['unread', 'open', 'archived', 'all'].includes(status || '') ? status : 'open') as any,
      tag: tag || undefined,
      showMuted: showMuted === 'true',
      q: q ? q.slice(0, 200) : undefined,
      page: Number(page) || 0,
    });
  }

  @Get('/counts')
  async counts(@GetOrgFromRequest() org: Organization) {
    const [items, messages, xPaused, follows] = await Promise.all([
      this._inbox.counts(org.id),
      this._dms.unreadCount(org.id),
      this._inbox.xPaused(org.id),
      this._follows.unreadCount(org.id),
    ]);
    return { ...items, messages, xPaused, follows };
  }

  @Get('/tags')
  tags(@GetOrgFromRequest() org: Organization) {
    return this._inbox.tags(org.id);
  }

  @Get('/people')
  people(@GetOrgFromRequest() org: Organization, @Query('muted') muted?: string, @Query('tag') tag?: string) {
    return this._inbox.people(org.id, { muted: muted === undefined ? undefined : muted === 'true', tag });
  }

  @Put('/people/:id')
  person(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { tags?: unknown; muted?: boolean; note?: string | null }
  ) {
    return wrap(() => this._inbox.updatePerson(org.id, id, body || {}));
  }

  @Post('/sync')
  async sync(@GetOrgFromRequest() org: Organization) {
    // "Check now" spends the install-wide X budget: once a minute per workspace
    if (!(await ioRedis.set(`bolt-inbox:check-now:${org.id}`, '1', 'EX', 60, 'NX'))) {
      return { started: false, running: false, wait: true };
    }
    if ((await this._inbox.isRunning()) || (await this._dms.isRunning())) return { started: false, running: true };
    this._inbox
      .syncAll(org.id, true)
      .then(() => this._dms.syncAll(org.id, true))
      .then(() => this._follows.syncAll(org.id, true))
      .catch(() => undefined);
    return { started: true };
  }

  // ---------- follows (declared before /:id/:action) ----------

  @Get('/follows')
  follows(
    @GetOrgFromRequest() org: Organization,
    @Query('channels') channels?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    @Query('showMuted') showMuted?: string,
    @Query('q') q?: string,
    @Query('page') page?: string
  ) {
    return this._follows.list(org.id, {
      integrationIds: list(channels),
      status: (['unread', 'open', 'archived', 'all'].includes(status || '') ? status : 'open') as any,
      tag: tag || undefined,
      showMuted: showMuted === 'true',
      q: q ? q.slice(0, 200) : undefined,
      page: Number(page) || 0,
    });
  }

  @Get('/follows/settings')
  followSettings(@GetOrgFromRequest() org: Organization) {
    return this._follows.settings(org.id);
  }

  @Put('/follows/settings/:id')
  async saveFollowSettings(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: { on?: boolean; verified?: boolean; minFollowers?: number }) {
    requireOrgAdmin(org);
    const channel = await this._prisma.integration.findFirst({
      where: { id, organizationId: org.id, deletedAt: null, providerIdentifier: { in: FOLLOW_PLATFORMS } },
      select: { id: true },
    });
    if (!channel) throw new HttpException('Channel not found', 404);
    const input: any = {};
    if (typeof body?.on === 'boolean') input.on = body.on;
    if (typeof body?.verified === 'boolean') input.verified = body.verified;
    if (body?.minFollowers !== undefined) input.minFollowers = Number(body.minFollowers) || 0;
    return saveFollowSetting(this._prisma, org.id, id, input);
  }

  @Post('/follows/mark')
  markFollows(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[]; action?: string }) {
    const action = body?.action;
    if (!['read', 'unread', 'archive', 'unarchive'].includes(action || '')) throw new HttpException('Bad request', 400);
    return this._follows.mark(org.id, this.ids(body), action as any);
  }

  @Post('/follows/delete')
  deleteFollows(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[] }) {
    return this._follows.remove(org.id, this.ids(body));
  }

  @Post('/follows/:id/follow-back')
  followBack(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return wrap(() => this._follows.followBack(org.id, id));
  }

  // ---------- direct messages (declared before /:id/:action so /dm/mark isn't taken for an item action) ----------

  @Get('/dm')
  conversations(
    @GetOrgFromRequest() org: Organization,
    @Query('channels') channels?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    @Query('showMuted') showMuted?: string,
    @Query('q') q?: string,
    @Query('page') page?: string
  ) {
    return this._dms.conversations(org.id, {
      integrationIds: list(channels),
      status: (['unread', 'open', 'archived', 'all'].includes(status || '') ? status : 'open') as any,
      tag: tag || undefined,
      showMuted: showMuted === 'true',
      q: q ? q.slice(0, 200) : undefined,
      page: Number(page) || 0,
    });
  }

  @Get('/dm/problems')
  problems(@GetOrgFromRequest() org: Organization) {
    return this._dms.problems(org.id);
  }

  @Post('/dm/mark')
  markConversations(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[]; action?: string }) {
    const action = body?.action;
    if (!['read', 'unread', 'archive', 'unarchive'].includes(action || '') || !Array.isArray(body?.ids)) {
      throw new HttpException('Bad request', 400);
    }
    return this._dms.mark(org.id, body.ids.map(String), action as any);
  }

  @Post('/dm/delete')
  deleteConversations(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[] }) {
    return this._dms.remove(org.id, this.ids(body));
  }

  @Get('/dm/:id')
  messages(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Query('before') before?: string) {
    return wrap(() => this._dms.messages(org.id, id, before && !isNaN(Date.parse(before)) ? before : undefined));
  }

  @Post('/dm/:id/send')
  send(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: { text?: string }) {
    return wrap(() => this._dms.send(org.id, id, String(body?.text || '')));
  }

  @Post('/mark')
  mark(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[]; action?: string }) {
    const action = body?.action;
    if (!['read', 'unread', 'archive', 'unarchive'].includes(action || '') || !Array.isArray(body?.ids)) {
      throw new HttpException('Bad request', 400);
    }
    return this._inbox.mark(org.id, body.ids.map(String), action as any);
  }

  @Post('/delete')
  deleteItems(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[] }) {
    return this._inbox.remove(org.id, this.ids(body));
  }

  @Post('/:id/:action')
  act(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: { text?: string }
  ) {
    if (!(INBOX_ACTIONS as readonly string[]).includes(action)) throw new HttpException('Unknown action', 400);
    return wrap(() => this._inbox.act(org.id, id, action as any, body?.text));
  }
}
