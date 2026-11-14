// Bolt Advantage: the inbox — collects mentions, replies and quotes per channel,
// keeps private tags/mutes per person, and replies, reposts, quotes or likes.
import { Injectable, Logger } from '@nestjs/common';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import type { Event } from 'nostr-tools';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { isLocked, withLock } from '@gitroom/nestjs-libraries/redis/bolt.lock';
import { buildLike, buildQuote, buildReply, buildRepost, InboxKind, NostrInbox } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.inbox';
import { XInbox } from '@gitroom/nestjs-libraries/bolt-inbox/x.inbox';
import { FacebookInbox } from '@gitroom/nestjs-libraries/bolt-inbox/facebook.inbox';
import { WebhookComment } from '@gitroom/nestjs-libraries/bolt-inbox/facebook.webhook';
import { IncomingInstagram, InstagramInbox } from '@gitroom/nestjs-libraries/bolt-inbox/instagram.inbox';
import { switchChecker } from '@gitroom/nestjs-libraries/bolt-inbox/switches';
import { UsageKind } from '@gitroom/nestjs-libraries/bolt-costs/usage';
import { chargeX, hasLink, worstItem, xBudgetLeft, xBudgetSettings, XPool, XResources } from '@gitroom/nestjs-libraries/bolt-costs/x-billing';

/** Channels with direct messages, and channels with mentions/comments. */
export const INBOX_PROVIDERS = ['nostr', 'x', 'facebook', 'instagram'];
export const MENTION_PROVIDERS = ['nostr', 'x', 'facebook', 'instagram'];
const LOCK_KEY = 'bolt-inbox:lock';
const NOSTR_FIRST_RUN_DAYS = 14;
const X_FIRST_RUN_DAYS = 7;
const FACEBOOK_FIRST_RUN_DAYS = 14;
const INSTAGRAM_FIRST_RUN_DAYS = 14;
// X costs money per item read, so check it less often than Nostr
const X_MIN_INTERVAL_MIN = 30;
const PAGE = 50;
/** Below this many dollars left for today, X checks wait for tomorrow. */
export const X_MIN_CHECK_USD = 0.03;

export type InboxFilters = {
  integrationIds?: string[];
  kinds?: InboxKind[];
  status?: 'unread' | 'open' | 'archived' | 'all';
  tag?: string;
  showMuted?: boolean;
  q?: string;
  page?: number;
};

const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);
const parseTags = (s: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
};
/** Tags are short labels: trimmed, lowercased, unique, at most 20 of 30 chars each. */
export const cleanTags = (tags: unknown) =>
  [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 20);

export const INBOX_ACTIONS = ['reply', 'repost', 'quote', 'like'] as const;
export type InboxAction = (typeof INBOX_ACTIONS)[number];
/** Moderating a comment on our own post (Facebook and Instagram). */
export const MODERATE_ACTIONS = ['hide', 'delete', 'ban'] as const;
const FB_AUTHOR_KEY = (commentId: string) => `bolt:fb-author:${commentId}`;
const FB_WEBHOOK_STATUS = 'fb-webhook-status';
export type ModerateAction = (typeof MODERATE_ACTIONS)[number];
const ACTION_STAMP = { reply: 'repliedAt', repost: 'repostedAt', quote: 'quotedAt', like: 'likedAt' } as const;

/** X Premium ("Verified" in the channel's preferences) allows 25,000 characters. */
export const xIsPremium = (integration: Pick<Integration, 'additionalSettings'>) => {
  try {
    const s = JSON.parse(integration.additionalSettings || '[]');
    return Array.isArray(s) && !!s.find((x: any) => x?.title === 'Verified')?.value;
  } catch {
    return false;
  }
};

@Injectable()
export class InboxService {
  private readonly _logger = new Logger('BoltInbox');

  constructor(
    private _prisma: PrismaService,
    private _refreshIntegrationService: RefreshIntegrationService
  ) {}

  // ---------- sync ----------

  async syncAll(organizationId?: string, force = false) {
    const ran = await withLock(LOCK_KEY, async () => {
      const integrations = await this._prisma.integration.findMany({
        where: {
          deletedAt: null,
          disabled: false,
          inBetweenSteps: false,
          refreshNeeded: false,
          type: 'social',
          providerIdentifier: { in: MENTION_PROVIDERS },
          ...(organizationId ? { organizationId } : {}),
        },
      });
      const isOff = switchChecker(this._prisma, 'mentions');
      for (const integration of integrations) {
        try {
          if (await isOff(integration)) continue;
          if (integration.providerIdentifier === 'nostr') await this.syncNostr(integration);
          if (integration.providerIdentifier === 'x') await this.syncX(integration, force);
          if (integration.providerIdentifier === 'facebook') await this.syncFacebook(integration);
          if (integration.providerIdentifier === 'instagram') await this.syncInstagram(integration);
        } catch (err: any) {
          this._logger.warn(`${integration.providerIdentifier} ${integration.id}: ${err?.message || err}`);
        }
      }
      return true;
    });
    return ran === true;
  }

  isRunning() {
    return isLocked(LOCK_KEY);
  }

  cursor(integrationId: string) {
    return this._prisma.inboxCursor.findUnique({ where: { integrationId } });
  }

  saveCursor(integrationId: string, data: { cursor?: string | null; since?: Date | null; error?: string | null }) {
    return this._prisma.inboxCursor.upsert({
      where: { integrationId },
      create: { integrationId, ...data, lastRunAt: new Date() },
      update: { ...data, lastRunAt: new Date() },
    });
  }

  async mutedAuthors(organizationId: string, platform: string) {
    const rows = await this._prisma.inboxPerson.findMany({
      where: { organizationId, platform, muted: true },
      select: { authorId: true },
    });
    return new Set(rows.map((r) => r.authorId));
  }

  async upsertPerson(organizationId: string, platform: string, authorId: string, p: { handle?: string; name?: string; avatar?: string }) {
    const data = {
      ...(p.handle ? { handle: clip(p.handle, 100) } : {}),
      ...(p.name ? { name: clip(p.name, 100) } : {}),
      // profile pictures come from strangers: only plain https images
      ...(p.avatar && /^https:\/\/[^\s"'<>]+$/i.test(p.avatar) ? { avatar: clip(p.avatar, 500) } : {}),
    };
    await this._prisma.inboxPerson.upsert({
      where: { organizationId_platform_authorId: { organizationId, platform, authorId } },
      create: { organizationId, platform, authorId, ...data },
      update: data,
    });
  }

  private async syncNostr(integration: Integration) {
    const state = await this.cursor(integration.id);
    const since = state?.since || dayjs().subtract(NOSTR_FIRST_RUN_DAYS, 'day').toDate();
    const nostr = new NostrInbox();
    const relays = await nostr.relays(integration.internalId);
    try {
      const incoming = await nostr.incoming(relays, integration.internalId, since);
      const muted = await this.mutedAuthors(integration.organizationId, 'nostr');
      const keep = incoming.filter((i) => !muted.has(i.event.pubkey));
      const profiles = await nostr.profiles(relays, [...new Set(keep.map((i) => i.event.pubkey))]);
      const targets = await nostr.events(relays, [...new Set(keep.map((i) => i.targetId).filter(Boolean) as string[])]);
      for (const i of keep) {
        const e = i.event;
        await this.upsertPerson(integration.organizationId, 'nostr', e.pubkey, profiles.get(e.pubkey) || {});
        await this._prisma.inboxItem.upsert({
          where: { integrationId_externalId: { integrationId: integration.id, externalId: e.id } },
          create: {
            organizationId: integration.organizationId,
            integrationId: integration.id,
            platform: 'nostr',
            externalId: e.id,
            kind: i.kind,
            authorId: e.pubkey,
            content: clip(e.content, 5000) || '',
            url: `https://primal.net/e/${e.id}`,
            inReplyToId: i.targetId,
            inReplyToText: clip(targets.get(i.targetId || '')?.content, 280),
            raw: JSON.stringify(e),
            publishedAt: new Date(e.created_at * 1000),
          },
          update: {},
        });
      }
      const newest = incoming.reduce((m, i) => Math.max(m, i.event.created_at), Math.floor(since.getTime() / 1000));
      // small overlap: relays can be a little behind each other
      await this.saveCursor(integration.id, { since: new Date((newest - 120) * 1000) });
    } finally {
      nostr.close(relays);
    }
  }

  /** Dollars left of the inbox's share of today's X budget. */
  xBudgetLeft() {
    return xBudgetLeft(this._prisma, 'x-inbox');
  }

  /** True when the org has X connected and today's inbox share is spent, so X checks are skipped. */
  async xPaused(organizationId: string) {
    if ((await this.xBudgetLeft()) >= X_MIN_CHECK_USD) return false;
    const x = await this._prisma.integration.count({
      where: { organizationId, providerIdentifier: 'x', deletedAt: null, disabled: false, type: 'social' },
    });
    return x > 0;
  }

  /** Price what X returned or what was sent, against today's budget and the channel's cost ledger. */
  charge(integration: Integration, kind: UsageKind, pool: XPool, r: XResources) {
    return chargeX(this._prisma, integration, kind, pool, r);
  }

  async token(integration: Integration) {
    if (!integration.tokenExpiration || dayjs(integration.tokenExpiration).isAfter(dayjs())) return integration.token;
    const r = await this._refreshIntegrationService.refresh(integration, 'bolt-inbox');
    if (!r) throw new Error('Reconnect this channel');
    return r.accessToken;
  }

  private async syncX(integration: Integration, force: boolean) {
    const state = await this.cursor(integration.id);
    if (!force && state?.lastRunAt && dayjs().diff(state.lastRunAt, 'minute') < X_MIN_INTERVAL_MIN) return;
    const budget = await this.xBudgetLeft();
    if (budget < X_MIN_CHECK_USD) return; // out of the inbox's share for today; try again tomorrow
    const { prices } = await xBudgetSettings(this._prisma);
    const x = new XInbox(await this.token(integration));
    const page = await x.mentions(integration.internalId, {
      sinceId: state?.cursor || undefined,
      max: Math.min(100, Math.floor(budget / worstItem(prices, 'mention'))),
      firstRunDays: X_FIRST_RUN_DAYS,
    });
    await this.charge(integration, 'inbox', 'x-inbox', page.resources);
    const muted = await this.mutedAuthors(integration.organizationId, 'x');
    for (const m of page.items.filter((i) => !muted.has(i.author.id))) {
      await this.upsertPerson(integration.organizationId, 'x', m.author.id, m.author);
      await this._prisma.inboxItem.upsert({
        where: { integrationId_externalId: { integrationId: integration.id, externalId: m.id } },
        create: {
          organizationId: integration.organizationId,
          integrationId: integration.id,
          platform: 'x',
          externalId: m.id,
          kind: m.kind,
          authorId: m.author.id,
          content: clip(m.text, 5000) || '',
          url: `https://x.com/${m.author.handle || 'i'}/status/${m.id}`,
          inReplyToId: m.targetId,
          inReplyToText: clip(m.targetText, 280),
          publishedAt: m.createdAt,
        },
        update: {},
      });
    }
    await this.saveCursor(integration.id, { cursor: page.newestId || state?.cursor || null });
  }

  private async syncFacebook(integration: Integration) {
    const state = await this.cursor(integration.id);
    const since = state?.since || dayjs().subtract(FACEBOOK_FIRST_RUN_DAYS, 'day').toDate();
    const fb = new FacebookInbox(integration.internalId, await this.token(integration));
    await this.ensureFeedPushes(integration, fb);
    let page;
    try {
      page = await fb.comments(since);
    } catch (err: any) {
      await this.saveCursor(integration.id, { error: clip(err?.message || String(err), 500) });
      throw err;
    }
    const muted = await this.mutedAuthors(integration.organizationId, 'facebook');
    for (const c of page.items) {
      // the webhook may already have said who wrote it
      if (c.author.id.startsWith('anon:')) {
        const known = await ioRedis.get(FB_AUTHOR_KEY(c.id)).catch(() => null);
        if (known) {
          try {
            c.author = JSON.parse(known);
          } catch {
            // keep it unnamed
          }
        }
      }
    }
    for (const c of page.items.filter((i) => !muted.has(i.author.id))) {
      await this.upsertPerson(integration.organizationId, 'facebook', c.author.id, { name: c.author.name });
      await this._prisma.inboxItem.upsert({
        where: { integrationId_externalId: { integrationId: integration.id, externalId: c.id } },
        create: {
          organizationId: integration.organizationId,
          integrationId: integration.id,
          platform: 'facebook',
          externalId: c.id,
          kind: 'reply',
          authorId: c.author.id,
          content: clip(c.text, 5000) || '',
          url: c.url,
          inReplyToId: c.targetId,
          inReplyToText: clip(c.targetText, 280),
          raw: JSON.stringify({ thread: c.threadId }),
          publishedAt: c.createdAt,
        },
        update: { url: c.url },
      });
    }
    await this.saveCursor(integration.id, { since: page.newest, error: null });
  }

  /** Comments on the account's recent posts, and posts it's tagged in. */
  private async syncInstagram(integration: Integration) {
    const ig = new InstagramInbox(integration.internalId, await this.token(integration));
    const self = { id: integration.internalId, username: integration.profile || undefined };
    const tagsCursor = `ig-tags:${integration.id}`;
    const [state, tagState] = await Promise.all([this.cursor(integration.id), this.cursor(tagsCursor)]);
    const first = dayjs().subtract(INSTAGRAM_FIRST_RUN_DAYS, 'day').toDate();
    try {
      const comments = await ig.comments(state?.since || first, self);
      await this.storeInstagram(integration, comments.items);
      await this.saveCursor(integration.id, { since: comments.newest, error: null });
      // tags are a bonus: a problem there doesn't hold up comments
      try {
        const tags = await ig.tags(tagState?.since || first);
        await this.storeInstagram(integration, tags.items);
        await this.saveCursor(tagsCursor, { since: tags.newest, error: null });
      } catch (err: any) {
        await this.saveCursor(tagsCursor, { error: clip(err?.message || String(err), 500) });
      }
    } catch (err: any) {
      await this.saveCursor(integration.id, { error: clip(err?.message || String(err), 500) });
      throw err;
    }
  }

  private async storeInstagram(integration: Integration, items: IncomingInstagram[]) {
    const muted = await this.mutedAuthors(integration.organizationId, 'instagram');
    for (const c of items.filter((i) => !muted.has(i.author.id))) {
      await this.upsertPerson(integration.organizationId, 'instagram', c.author.id, { handle: c.author.handle, name: c.author.handle });
      await this._prisma.inboxItem.upsert({
        where: { integrationId_externalId: { integrationId: integration.id, externalId: c.id } },
        create: {
          organizationId: integration.organizationId,
          integrationId: integration.id,
          platform: 'instagram',
          externalId: c.id,
          kind: c.kind,
          authorId: c.author.id,
          content: clip(c.text, 5000) || '',
          url: c.url,
          inReplyToId: c.targetId,
          inReplyToText: clip(c.targetText, 280),
          raw: c.threadId ? JSON.stringify({ thread: c.threadId }) : null,
          publishedAt: c.createdAt,
        },
        update: {},
      });
    }
  }

  // ---------- reading ----------

  async list(organizationId: string, f: InboxFilters) {
    const people = await this._prisma.inboxPerson.findMany({ where: { organizationId } });
    const personKey = (platform: string, authorId: string) => `${platform}:${authorId}`;
    const byKey = new Map(people.map((p) => [personKey(p.platform, p.authorId), { ...p, tags: parseTags(p.tags) }]));
    const muted = people.filter((p) => p.muted);
    const tagged = f.tag ? people.filter((p) => parseTags(p.tags).includes(f.tag!.toLowerCase())) : null;

    const and: any[] = [];
    if (!f.showMuted && muted.length) {
      and.push({ NOT: { OR: muted.map((p) => ({ platform: p.platform, authorId: p.authorId })) } });
    }
    if (tagged) {
      and.push(tagged.length ? { OR: tagged.map((p) => ({ platform: p.platform, authorId: p.authorId })) } : { id: '__none__' });
    }
    const status = f.status || 'open';
    const where: any = {
      organizationId,
      ...(f.integrationIds?.length ? { integrationId: { in: f.integrationIds } } : {}),
      ...(f.kinds?.length ? { kind: { in: f.kinds } } : {}),
      ...(status === 'unread' ? { readAt: null, archivedAt: null } : status === 'open' ? { archivedAt: null } : status === 'archived' ? { archivedAt: { not: null } } : {}),
      ...(f.q ? { content: { contains: f.q, mode: 'insensitive' } } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const page = Math.max(0, f.page || 0);
    const [total, rows] = await Promise.all([
      this._prisma.inboxItem.count({ where }),
      this._prisma.inboxItem.findMany({ where, orderBy: { publishedAt: 'desc' }, skip: page * PAGE, take: PAGE, omit: { raw: true } } as any),
    ]);
    return {
      total,
      pages: Math.ceil(total / PAGE),
      items: (rows as any[]).map((r) => ({ ...r, person: byKey.get(personKey(r.platform, r.authorId)) || null })),
    };
  }

  async counts(organizationId: string) {
    const muted = await this._prisma.inboxPerson.findMany({ where: { organizationId, muted: true }, select: { platform: true, authorId: true } });
    const rows = await this._prisma.inboxItem.groupBy({
      by: ['integrationId'],
      where: {
        organizationId,
        readAt: null,
        archivedAt: null,
        ...(muted.length ? { NOT: { OR: muted.map((p) => ({ platform: p.platform, authorId: p.authorId })) } } : {}),
      },
      _count: { _all: true },
    });
    const byChannel = Object.fromEntries(rows.map((r) => [r.integrationId, r._count._all]));
    return { unread: rows.reduce((s, r) => s + r._count._all, 0), byChannel, problems: await this.problems(organizationId) };
  }

  /** Last fetch problem per Facebook channel (e.g. a permission Meta took away). */
  async problems(organizationId: string): Promise<Record<string, string>> {
    const channels = await this._prisma.integration.findMany({
      where: { organizationId, deletedAt: null, providerIdentifier: { in: ['facebook', 'instagram'] } },
      select: { id: true, updatedAt: true },
    });
    if (!channels.length) return {};
    const rows = await this._prisma.inboxCursor.findMany({ where: { integrationId: { in: channels.map((c) => c.id) }, error: { not: null } } });
    const changed = new Map(channels.map((c) => [c.id, c.updatedAt]));
    // a reconnect after the failed check may already have fixed it; the next check will say
    const current = rows.filter((r) => !r.lastRunAt || r.lastRunAt >= (changed.get(r.integrationId) || new Date(0)));
    return Object.fromEntries(current.map((r) => [r.integrationId, r.error as string]));
  }

  async tags(organizationId: string) {
    const people = await this._prisma.inboxPerson.findMany({ where: { organizationId }, select: { tags: true } });
    const counts = new Map<string, number>();
    for (const p of people) for (const t of parseTags(p.tags)) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, people]) => ({ tag, people }));
  }

  async people(organizationId: string, filter: { muted?: boolean; tag?: string }) {
    const rows = await this._prisma.inboxPerson.findMany({
      where: { organizationId, ...(filter.muted !== undefined ? { muted: filter.muted } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    return rows.map((p) => ({ ...p, tags: parseTags(p.tags) })).filter((p) => !filter.tag || p.tags.includes(filter.tag.toLowerCase()));
  }

  async updatePerson(organizationId: string, personId: string, body: { tags?: unknown; muted?: boolean; note?: string | null }) {
    const person = await this._prisma.inboxPerson.findFirst({ where: { id: personId, organizationId } });
    if (!person) throw new Error('Person not found');
    const updated = await this._prisma.inboxPerson.update({
      where: { id: person.id },
      data: {
        ...(body.tags !== undefined ? { tags: JSON.stringify(cleanTags(body.tags)) } : {}),
        ...(body.muted !== undefined ? { muted: !!body.muted } : {}),
        ...(body.note !== undefined ? { note: body.note ? String(body.note).slice(0, 1000) : null } : {}),
      },
    });
    return { ...updated, tags: parseTags(updated.tags) };
  }

  async mark(organizationId: string, ids: string[], action: 'read' | 'unread' | 'archive' | 'unarchive') {
    const data =
      action === 'read' ? { readAt: new Date() } : action === 'unread' ? { readAt: null } : action === 'archive' ? { archivedAt: new Date(), readAt: new Date() } : { archivedAt: null };
    const r = await this._prisma.inboxItem.updateMany({ where: { organizationId, id: { in: ids.slice(0, 500) } }, data });
    return { updated: r.count };
  }

  /** Removes items from the inbox only; nothing changes on the social network. */
  async remove(organizationId: string, ids: string[]) {
    const r = await this._prisma.inboxItem.deleteMany({ where: { organizationId, id: { in: ids.slice(0, 500) } } });
    return { deleted: r.count };
  }

  // ---------- acting ----------

  private async itemWithChannel(organizationId: string, itemId: string) {
    const item = await this._prisma.inboxItem.findFirst({ where: { id: itemId, organizationId } });
    if (!item) throw new Error('Item not found');
    const integration = await this._prisma.integration.findFirst({ where: { id: item.integrationId, organizationId, deletedAt: null } });
    if (!integration) throw new Error('That channel is no longer connected');
    return { item, integration };
  }

  nostrSecret(integration: Integration) {
    const { password } = (AuthService.verifyJWT(integration.token) as any) || {};
    return String(password || '');
  }

  /** Once per connection: ask Facebook to push this Page's comments to the webhook. */
  private async ensureFeedPushes(integration: Integration, fb: FacebookInbox) {
    const id = `fb-feed-sub:${integration.id}`;
    const state = await this.cursor(id);
    if (state?.cursor === 'ok' && state.lastRunAt && state.lastRunAt >= integration.updatedAt) return;
    try {
      await fb.subscribe();
      await this.saveCursor(id, { cursor: 'ok', error: null });
    } catch (err: any) {
      // comments still arrive every 10 minutes without it, just unnamed
      await this.saveCursor(id, { cursor: null, error: clip(err?.message || String(err), 500) });
    }
  }

  /**
   * From a webhook push: who wrote which comment. Remembered for a month so
   * the regular pass can name new comments, and applied to comments already
   * in the inbox.
   */
  async learnFacebookAuthors(comments: WebhookComment[]) {
    const named = comments.filter((c) => c.from && c.verb !== 'remove');
    await this._prisma.boltSetting.upsert({
      where: { key: FB_WEBHOOK_STATUS },
      create: { key: FB_WEBHOOK_STATUS, value: JSON.stringify({ at: new Date(), comments: comments.length, withAuthor: named.length }) },
      update: { value: JSON.stringify({ at: new Date(), comments: comments.length, withAuthor: named.length }) },
    });
    for (const c of named) {
      const author = { id: c.from!.id, name: c.from!.name };
      // our own Page's comments aren't inbox items
      if (author.id === c.pageId) continue;
      await ioRedis.set(FB_AUTHOR_KEY(c.commentId), JSON.stringify(author), 'EX', 30 * 86400).catch(() => undefined);
      const items = await this._prisma.inboxItem.findMany({ where: { platform: 'facebook', externalId: c.commentId, authorId: { startsWith: 'anon:' } } });
      for (const item of items) {
        await this.upsertPerson(item.organizationId, 'facebook', author.id, { name: author.name });
        await this._prisma.inboxItem.update({ where: { id: item.id }, data: { authorId: author.id } });
      }
    }
  }

  /**
   * Hide or delete a comment someone left on one of our posts. Works by the
   * comment's id, so it doesn't need to know who wrote it. Hidden comments
   * are archived here; deleted ones are removed from the inbox.
   */
  async moderate(organizationId: string, itemId: string, action: ModerateAction) {
    const { item, integration } = await this.itemWithChannel(organizationId, itemId);
    const token = await this.token(integration);
    if (action === 'ban') {
      if (item.platform !== 'facebook') throw new Error('Banning is only possible on Facebook Pages');
      if (item.authorId.startsWith('anon:')) {
        throw new Error("Facebook hasn't said who wrote this comment yet, so they can't be banned from here. Hide or delete it instead.");
      }
      const fb = new FacebookInbox(integration.internalId, token);
      await fb.ban(item.authorId);
      // their comment goes too: hidden, so they don't notice
      await fb.hide(item.externalId).catch(() => undefined);
      await this._prisma.inboxPerson.updateMany({ where: { organizationId, platform: 'facebook', authorId: item.authorId }, data: { muted: true } });
      const stamp = new Date();
      await this._prisma.inboxItem.updateMany({
        where: { organizationId, platform: 'facebook', authorId: item.authorId, archivedAt: null },
        data: { archivedAt: stamp, readAt: stamp },
      });
      return { ok: true };
    }
    const target =
      item.platform === 'facebook'
        ? new FacebookInbox(integration.internalId, token)
        : item.platform === 'instagram' && item.kind !== 'mention'
        ? new InstagramInbox(integration.internalId, token)
        : null;
    if (!target) throw new Error('Only comments on your Facebook and Instagram posts can be hidden or deleted');
    try {
      if (action === 'hide') await target.hide(item.externalId);
      else await target.remove(item.externalId);
    } catch (err: any) {
      // already gone on their side: just tidy up here
      if (!/does not exist|cannot be loaded|Unsupported (post|delete) request/i.test(err?.message || '')) throw err;
    }
    if (action === 'delete') {
      await this._prisma.inboxItem.delete({ where: { id: item.id } });
    } else {
      const stamp = new Date();
      let raw: any = {};
      try {
        raw = JSON.parse(item.raw || '{}');
      } catch {
        raw = {};
      }
      await this._prisma.inboxItem.update({
        where: { id: item.id },
        data: { readAt: item.readAt || stamp, archivedAt: stamp, raw: JSON.stringify({ ...raw, hidden: true }) },
      });
    }
    return { ok: true };
  }

  async act(organizationId: string, itemId: string, action: InboxAction, text?: string) {
    const clean = (text || '').trim();
    const needsText = action === 'reply' || action === 'quote';
    if (needsText && !clean) throw new Error('Write something first');
    const { item, integration } = await this.itemWithChannel(organizationId, itemId);

    let externalId: string | null = null;
    if (item.platform === 'nostr') {
      if (!item.raw) throw new Error('Original note missing; sync again');
      const target = JSON.parse(item.raw) as Event;
      const nostr = new NostrInbox();
      const relays = await nostr.relays(integration.internalId);
      try {
        const template =
          action === 'reply'
            ? buildReply(target, clean, integration.internalId, relays)
            : action === 'quote'
            ? buildQuote(target, clean, relays)
            : action === 'like'
            ? buildLike(target, relays)
            : buildRepost(target, relays);
        externalId = (await nostr.publish(relays, template, this.nostrSecret(integration))).id;
      } finally {
        nostr.close(relays);
      }
    } else if (item.platform === 'x') {
      const limit = xIsPremium(integration) ? 25000 : 280;
      if (needsText && clean.length > limit) {
        throw new Error(`X posts are limited to ${limit.toLocaleString()} characters${limit === 280 ? ' (tick Verified in the channel preferences if this account has X Premium)' : ''}`);
      }
      const x = new XInbox(await this.token(integration));
      if (action === 'reply') externalId = await x.reply(item.externalId, clean);
      if (action === 'quote') externalId = await x.quote(item.externalId, clean);
      if (action === 'repost') await x.repost(integration.internalId, item.externalId);
      if (action === 'like') await x.like(integration.internalId, item.externalId);
      const link = (action === 'reply' || action === 'quote') && hasLink(clean);
      await this.charge(integration, 'write', 'x-write', link ? { urlWrites: 1 } : { writes: 1 });
    } else if (item.platform === 'facebook') {
      if (action === 'repost' || action === 'quote') throw new Error('Facebook comments can be replied to or liked');
      const fb = new FacebookInbox(integration.internalId, await this.token(integration));
      let thread = item.externalId;
      try {
        thread = JSON.parse(item.raw || '{}').thread || thread;
      } catch {
        // keep the comment itself
      }
      if (action === 'reply') externalId = await fb.reply(thread, clean);
      if (action === 'like') await fb.like(item.externalId);
    } else if (item.platform === 'instagram') {
      if (action !== 'reply') throw new Error('Instagram comments can be replied to; liking them isn’t possible through Instagram’s API');
      const ig = new InstagramInbox(integration.internalId, await this.token(integration));
      if (item.kind === 'mention') {
        // a tag: only possible when the caption @mentions the account
        try {
          externalId = await ig.replyToMention(item.inReplyToId || item.externalId.replace(/^tag:/, ''), clean);
        } catch (err: any) {
          throw new Error(`Instagram only allows replying when the caption @mentions you; open the post to comment instead. (${err?.message || err})`);
        }
      } else {
        let thread = item.externalId;
        try {
          thread = JSON.parse(item.raw || '{}').thread || thread;
        } catch {
          // keep the comment itself
        }
        externalId = await ig.reply(thread, clean);
      }
    } else {
      throw new Error('This channel does not support that yet');
    }

    const stamp = new Date();
    await this._prisma.inboxItem.update({
      where: { id: item.id },
      data: {
        readAt: item.readAt || stamp,
        [ACTION_STAMP[action]]: stamp,
      },
    });
    return { ok: true, externalId };
  }
}
