// Bolt Advantage: the inbox (mentions, replies, quotes, direct messages) with private people tags and mutes.
import { Body, Controller, Get, HttpException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { INBOX_ACTIONS, InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { DmService } from '@gitroom/nestjs-libraries/bolt-inbox/dm.service';

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
    private _dms: DmService
  ) {}

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
    const [items, messages] = await Promise.all([this._inbox.counts(org.id), this._dms.unreadCount(org.id)]);
    return { ...items, messages };
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
    if ((await this._inbox.isRunning()) || (await this._dms.isRunning())) return { started: false, running: true };
    this._inbox
      .syncAll(org.id, true)
      .then(() => this._dms.syncAll(org.id, true))
      .catch(() => undefined);
    return { started: true };
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
