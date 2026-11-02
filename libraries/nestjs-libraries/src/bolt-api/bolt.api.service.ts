// Bolt Advantage: one place that shapes Bolt features (inbox, messages,
// people, queue, pause, saved analytics) for outside callers — the MCP tools
// AI agents use and the API-key public API — so both always match. Also client costs.
import { Injectable } from '@nestjs/common';
import { INBOX_ACTIONS, InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { DmService } from '@gitroom/nestjs-libraries/bolt-inbox/dm.service';
import { QueueService } from '@gitroom/nestjs-libraries/bolt-queue/queue.service';
import { PauseService } from '@gitroom/nestjs-libraries/bolt-queue/pause.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { BoltAnalyticsQueries } from '@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.queries';
import { CostsService } from '@gitroom/nestjs-libraries/bolt-costs/costs.service';

export type BoltStatus = 'open' | 'unread' | 'archived' | 'all';
const STATUSES: BoltStatus[] = ['open', 'unread', 'archived', 'all'];
const KINDS = ['mention', 'reply', 'quote'];

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const status = (s?: string): BoltStatus => (STATUSES.includes(s as BoltStatus) ? (s as BoltStatus) : 'open');
const clampDays = (v: unknown, fallback: number) => Math.min(365, Math.max(1, Number(v) || fallback));
export const validZone = (tz?: string | null) => {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
};

const person = (p: any) =>
  p ? { id: p.id, platform: p.platform, name: p.name, handle: p.handle, tags: p.tags || [], muted: !!p.muted, note: p.note || null } : null;

@Injectable()
export class BoltApiService {
  constructor(
    private _inbox: InboxService,
    private _dms: DmService,
    private _queue: QueueService,
    private _pause: PauseService,
    private _posts: PostsService,
    private _analytics: BoltAnalyticsQueries,
    private _costs: CostsService
  ) {}

  // ---------- client costs ----------

  /** Metered API use and estimated cost per client and channel, inclusive YYYY-MM-DD range (default: this month). */
  costs(orgId: string, from?: string, to?: string) {
    return this._costs.report(orgId, from, to);
  }

  // ---------- inbox (mentions, replies, quotes) ----------

  async inbox(orgId: string, f: { status?: string; channels?: string[]; kinds?: string[]; tag?: string; q?: string; page?: number; showMuted?: boolean }) {
    const r = await this._inbox.list(orgId, {
      status: status(f.status),
      integrationIds: f.channels?.length ? f.channels : undefined,
      kinds: f.kinds?.filter((k) => KINDS.includes(k)) as any,
      tag: f.tag || undefined,
      q: f.q ? String(f.q).slice(0, 200) : undefined,
      page: Math.max(0, Number(f.page) || 0),
      showMuted: !!f.showMuted,
    });
    const counts = await this._inbox.counts(orgId);
    return {
      total: r.total,
      pages: r.pages,
      unread: counts.unread,
      items: r.items.map((i: any) => ({
        id: i.id,
        integrationId: i.integrationId,
        platform: i.platform,
        kind: i.kind,
        text: i.content,
        url: i.url,
        inReplyToText: i.inReplyToText,
        publishedAt: iso(i.publishedAt),
        read: !!i.readAt,
        archived: !!i.archivedAt,
        replied: !!i.repliedAt,
        reposted: !!i.repostedAt,
        quoted: !!i.quotedAt,
        liked: !!i.likedAt,
        person: person(i.person),
      })),
    };
  }

  respond(orgId: string, itemId: string, action: string, text?: string) {
    if (!(INBOX_ACTIONS as readonly string[]).includes(action)) throw new Error('action must be reply, repost, quote or like');
    return this._inbox.act(orgId, itemId, action as any, text);
  }

  markInbox(orgId: string, ids: string[], action: string) {
    if (!['read', 'unread', 'archive', 'unarchive'].includes(action)) throw new Error('action must be read, unread, archive or unarchive');
    return this._inbox.mark(orgId, ids.map(String), action as any);
  }

  // ---------- direct messages ----------

  async conversations(orgId: string, f: { status?: string; channels?: string[]; tag?: string; q?: string; page?: number; showMuted?: boolean }) {
    const r = await this._dms.conversations(orgId, {
      status: status(f.status),
      integrationIds: f.channels?.length ? f.channels : undefined,
      tag: f.tag || undefined,
      q: f.q ? String(f.q).slice(0, 200) : undefined,
      page: Math.max(0, Number(f.page) || 0),
      showMuted: !!f.showMuted,
    });
    return {
      total: r.total,
      pages: r.pages,
      unreadConversations: await this._dms.unreadCount(orgId),
      problems: await this._dms.problems(orgId),
      conversations: r.conversations.map((c: any) => ({
        id: c.id,
        integrationId: c.integrationId,
        platform: c.platform,
        lastMessageAt: iso(c.lastMessageAt),
        lastMessage: c.lastPreview,
        lastFrom: c.lastDirection === 'out' ? 'you' : 'them',
        unread: c.unread,
        archived: !!c.archivedAt,
        person: person(c.person),
      })),
    };
  }

  async conversation(orgId: string, id: string, opts: { before?: string; markRead?: boolean }) {
    const before = opts.before && !isNaN(Date.parse(opts.before)) ? opts.before : undefined;
    const r = await this._dms.messages(orgId, id, before, !!opts.markRead);
    return {
      conversationId: r.conversation.id,
      platform: r.conversation.platform,
      unread: r.conversation.unread,
      more: r.more,
      messages: r.messages.map((m) => ({ id: m.id, from: m.direction === 'out' ? 'you' : 'them', text: m.content, sentAt: iso(m.sentAt) })),
    };
  }

  async sendMessage(orgId: string, id: string, text: string) {
    const m = await this._dms.send(orgId, id, text);
    return { id: m.id, sentAt: iso(m.sentAt) };
  }

  markConversations(orgId: string, ids: string[], action: string) {
    if (!['read', 'unread', 'archive', 'unarchive'].includes(action)) throw new Error('action must be read, unread, archive or unarchive');
    return this._dms.mark(orgId, ids.map(String), action as any);
  }

  // ---------- people ----------

  async people(orgId: string, f: { muted?: boolean; tag?: string }) {
    return (await this._inbox.people(orgId, f)).map(person);
  }

  async updatePerson(orgId: string, id: string, body: { tags?: unknown; muted?: boolean; note?: string | null }) {
    return person(await this._inbox.updatePerson(orgId, id, body));
  }

  async tags(orgId: string) {
    return this._inbox.tags(orgId);
  }

  // ---------- queue and pause ----------

  async queues(orgId: string, nextCount = 5) {
    const n = Math.min(20, Math.max(1, Number(nextCount) || 5));
    const [list, pause] = await Promise.all([this._queue.list(orgId), this._pause.status(orgId)]);
    return {
      postingPaused: pause.paused,
      pausedAt: iso(pause.pausedAt),
      heldPosts: pause.held,
      channels: await Promise.all(
        list.map(async (c: any) => ({
          integrationId: c.integration.id,
          name: c.integration.name,
          platform: c.integration.providerIdentifier,
          queue: c.queue,
          nextOpenTimes: ((await this._queue.next(orgId, c.integration.id, n)) || []).map(iso),
          thisWeek: c.week.map((w: any) => ({ at: iso(w.at), kind: w.kind, post: w.post })),
        }))
      ),
    };
  }

  async nextOpenTimes(orgId: string, integrationId: string, count = 1) {
    const n = Math.min(20, Math.max(1, Number(count) || 1));
    return { integrationId, times: ((await this._queue.next(orgId, integrationId, n)) || []).map(iso) };
  }

  async setPaused(orgId: string, paused: boolean) {
    return paused ? { paused: true, ...(await this._pause.pause(orgId)) } : { paused: false, ...(await this._posts.resumePosting(orgId)) };
  }

  /** Change one channel's queue: weekly times, posts per day (then picks best times), days off, Sunday refresh. */
  async updateQueue(
    orgId: string,
    integrationId: string,
    body: { timeZone?: string; slots?: unknown; perDay?: unknown; pickBestTimes?: boolean; daysOff?: unknown; autoAdjust?: boolean; paused?: boolean }
  ) {
    const current = (await this._queue.list(orgId)).find((c: any) => c.integration.id === integrationId);
    if (!current) throw new Error('Channel not found');
    const base = current.queue || { timeZone: 'UTC', slots: [] };
    const settings = ['timeZone', 'slots', 'perDay', 'autoAdjust', 'paused'].some((k) => (body as any)[k] !== undefined);
    if (settings || !current.queue) {
      await this._queue.save(orgId, integrationId, {
        timeZone: validZone(body.timeZone || base.timeZone),
        slots: body.slots !== undefined ? body.slots : base.slots,
        ...(body.perDay !== undefined ? { perDay: body.perDay } : {}),
        ...(body.autoAdjust !== undefined ? { autoAdjust: !!body.autoAdjust } : {}),
        // save() treats a missing "paused" as false, so carry the current value
        paused: body.paused !== undefined ? !!body.paused : !!(base as any).paused,
      });
    }
    if (body.daysOff !== undefined) await this._queue.setDaysOff(orgId, integrationId, body.daysOff, body.timeZone || base.timeZone);
    if (body.pickBestTimes) await this._queue.autoPick(orgId, integrationId, body.perDay);
    return (await this.queues(orgId, 3)).channels.find((c) => c.integrationId === integrationId);
  }

  // ---------- saved analytics ----------

  async analytics(orgId: string, f: { days?: number; integrationId?: string; timeZone?: string; include?: string[] }) {
    const days = clampDays(f.days, 30);
    const want = new Set(f.include?.length ? f.include : ['summary', 'followers', 'topPosts', 'bestTimes']);
    const out: Record<string, unknown> = { days };
    if (want.has('summary')) {
      const s = await this._analytics.summary(orgId, days);
      out.summary = s
        .filter((c: any) => !f.integrationId || c.integration.id === f.integrationId)
        .map((c: any) => ({ ...c, integration: { id: c.integration.id, name: c.integration.name, platform: c.integration.providerIdentifier } }));
    }
    if (want.has('followers')) {
      out.followers = (await this._analytics.followers(orgId, days)).filter((c) => !f.integrationId || c.integrationId === f.integrationId);
    }
    if (want.has('topPosts')) {
      const p = await this._analytics.posts(orgId, { integrationId: f.integrationId, days, sort: 'engagement', page: 0 });
      out.topPosts = p.posts.slice(0, 20).map((x: any) => ({
        integrationId: x.integrationId,
        url: x.url,
        text: (x.content || '').slice(0, 280),
        publishedAt: iso(x.publishedAt),
        impressions: x.impressions,
        engagement: x.engagement,
        metrics: x.metrics,
      }));
    }
    if (want.has('bestTimes')) out.bestTimes = await this._analytics.bestTimes(orgId, f.integrationId, validZone(f.timeZone));
    return out;
  }
}
