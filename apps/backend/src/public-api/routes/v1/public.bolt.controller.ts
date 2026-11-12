// Bolt Advantage: the Bolt features on the API-key public API (/public/v1/bolt/...),
// for bots and automations (n8n, Make, scripts). Same data and rules as the
// MCP tools — both go through BoltApiService.
import { Body, Controller, Get, HttpException, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { BoltApiService } from '@gitroom/nestjs-libraries/bolt-api/bolt.api.service';

const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const wrap = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e: any) {
    throw new HttpException(e?.message || 'Something went wrong', 400);
  }
};
const ids = (body: any) => {
  if (!Array.isArray(body?.ids) || typeof body?.action !== 'string') throw new HttpException('Send { ids: [...], action }', 400);
  return body.ids.map(String) as string[];
};

@ApiTags('Public API')
@Controller('/public/v1/bolt')
export class PublicBoltController {
  constructor(private _api: BoltApiService) {}

  // ---------- inbox ----------

  @Get('/inbox')
  inbox(
    @GetOrgFromRequest() org: Organization,
    @Query('status') status?: string,
    @Query('channels') channels?: string,
    @Query('kinds') kinds?: string,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
    @Query('showMuted') showMuted?: string,
    @Query('page') page?: string
  ) {
    return this._api.inbox(org.id, { status, channels: list(channels), kinds: list(kinds), tag, q, showMuted: showMuted === 'true', page: Number(page) || 0 });
  }

  @Post('/inbox/mark')
  markInbox(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[]; action?: string }) {
    return wrap(() => this._api.markInbox(org.id, ids(body), body.action!));
  }

  @Post('/inbox/:id/:action')
  respond(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Param('action') action: string, @Body() body: { text?: string }) {
    return wrap(() => this._api.respond(org.id, id, action, body?.text));
  }

  // ---------- follows ----------

  @Get('/follows')
  follows(
    @GetOrgFromRequest() org: Organization,
    @Query('status') status?: string,
    @Query('channels') channels?: string,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
    @Query('showMuted') showMuted?: string,
    @Query('page') page?: string
  ) {
    return this._api.follows(org.id, { status, channels: list(channels), tag, q, showMuted: showMuted === 'true', page: Number(page) || 0 });
  }

  // ---------- direct messages ----------

  @Get('/messages')
  conversations(
    @GetOrgFromRequest() org: Organization,
    @Query('status') status?: string,
    @Query('channels') channels?: string,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
    @Query('showMuted') showMuted?: string,
    @Query('page') page?: string
  ) {
    return this._api.conversations(org.id, { status, channels: list(channels), tag, q, showMuted: showMuted === 'true', page: Number(page) || 0 });
  }

  @Post('/messages/mark')
  markConversations(@GetOrgFromRequest() org: Organization, @Body() body: { ids?: string[]; action?: string }) {
    return wrap(() => this._api.markConversations(org.id, ids(body), body.action!));
  }

  @Get('/messages/:id')
  conversation(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Query('before') before?: string, @Query('markRead') markRead?: string) {
    return wrap(() => this._api.conversation(org.id, id, { before, markRead: markRead === 'true' }));
  }

  @Post('/messages/:id/send')
  send(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: { text?: string }) {
    return wrap(() => this._api.sendMessage(org.id, id, String(body?.text || '')));
  }

  // ---------- people ----------

  @Get('/people')
  async people(@GetOrgFromRequest() org: Organization, @Query('muted') muted?: string, @Query('tag') tag?: string) {
    return { people: await this._api.people(org.id, { muted: muted === undefined ? undefined : muted === 'true', tag }), tags: await this._api.tags(org.id) };
  }

  @Put('/people/:id')
  person(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: { tags?: unknown; muted?: boolean; note?: string | null }) {
    return wrap(() => this._api.updatePerson(org.id, id, body || {}));
  }

  // ---------- queue and pause ----------

  @Get('/queue')
  queues(@GetOrgFromRequest() org: Organization, @Query('next') next?: string) {
    return this._api.queues(org.id, Number(next) || 5);
  }

  @Put('/queue/pause')
  pause(@GetOrgFromRequest() org: Organization, @Body() body: { paused?: boolean }) {
    if (typeof body?.paused !== 'boolean') throw new HttpException('Send { paused: true | false }', 400);
    return wrap(() => this._api.setPaused(org.id, body.paused!));
  }

  @Get('/queue/:integrationId/next')
  next(@GetOrgFromRequest() org: Organization, @Param('integrationId') integrationId: string, @Query('count') count?: string) {
    return this._api.nextOpenTimes(org.id, integrationId, Number(count) || 1);
  }

  @Put('/queue/:integrationId')
  updateQueue(@GetOrgFromRequest() org: Organization, @Param('integrationId') integrationId: string, @Body() body: any) {
    return wrap(() => this._api.updateQueue(org.id, integrationId, body || {}));
  }

  // ---------- client costs ----------

  @Get('/costs')
  costs(@GetOrgFromRequest() org: Organization, @Query('from') from?: string, @Query('to') to?: string) {
    return wrap(() => this._api.costs(org.id, from, to));
  }

  // ---------- saved analytics ----------

  @Get('/analytics')
  analytics(
    @GetOrgFromRequest() org: Organization,
    @Query('days') days?: string,
    @Query('integrationId') integrationId?: string,
    @Query('timeZone') timeZone?: string,
    @Query('include') include?: string
  ) {
    return this._api.analytics(org.id, { days: Number(days) || undefined, integrationId, timeZone, include: list(include) });
  }
}
