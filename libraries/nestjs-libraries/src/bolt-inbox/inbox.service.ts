// Bolt Advantage: the inbox — collects mentions, replies and quotes per channel,
// keeps private tags/mutes per person, and replies, reposts or quotes.
import { Injectable, Logger } from '@nestjs/common';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import type { Event } from 'nostr-tools';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { isLocked, withLock } from '@gitroom/nestjs-libraries/redis/bolt.lock';
import { X_INBOX_READS, X_INBOX_USAGE } from '@gitroom/nestjs-libraries/bolt-analytics/x.analytics';
import { dayKey } from '@gitroom/nestjs-libraries/bolt-analytics/schedule';
import { buildQuote, buildReply, buildRepost, InboxKind, NostrInbox } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.inbox';
import { XInbox } from '@gitroom/nestjs-libraries/bolt-inbox/x.inbox';
import { recordChannelUsage, UsageKind } from '@gitroom/nestjs-libraries/bolt-costs/usage';

export const INBOX_PROVIDERS = ['nostr', 'x'];
const LOCK_KEY = 'bolt-inbox:lock';
const NOSTR_FIRST_RUN_DAYS = 14;
const X_FIRST_RUN_DAYS = 7;
// X costs money per item read, so check it less often than Nostr
const X_MIN_INTERVAL_MIN = 30;
const PAGE = 50;

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
          providerIdentifier: { in: INBOX_PROVIDERS },
          ...(organizationId ? { organizationId } : {}),
        },
      });
      for (const integration of integrations) {
        try {
          if (integration.providerIdentifier === 'nostr') await this.syncNostr(integration);
          if (integration.providerIdentifier === 'x') await this.syncX(integration, force);
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
      ...(p.avatar ? { avatar: clip(p.avatar, 500) } : {}),
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

  async xBudgetLeft() {
    const row = await this._prisma.analyticsApiUsage.findUnique({ where: { provider_date: { provider: X_INBOX_USAGE, date: dayKey() } } });
    return Math.max(0, X_INBOX_READS() - (row?.reads || 0));
  }

  /** Count against the install-wide cap, and (with a channel) on that channel's cost ledger. */
  async addUsage(provider: string, n: number, channel?: { integration: Integration; kind: UsageKind }) {
    if (channel) await recordChannelUsage(this._prisma, channel.integration, channel.kind, n);
    return this._prisma.analyticsApiUsage.upsert({
      where: { provider_date: { provider, date: dayKey() } },
      create: { provider, date: dayKey(), reads: n },
      update: { reads: { increment: n } },
    });
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
    if (budget < 5) return; // out of the inbox's share for today; try again tomorrow
    const x = new XInbox(await this.token(integration));
    const page = await x.mentions(integration.internalId, {
      sinceId: state?.cursor || undefined,
      max: Math.min(100, Math.floor(budget / 2)),
      firstRunDays: X_FIRST_RUN_DAYS,
    });
    await this.addUsage(X_INBOX_USAGE, Math.max(1, page.reads), { integration, kind: 'inbox' });
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
    return { unread: rows.reduce((s, r) => s + r._count._all, 0), byChannel };
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

  async act(organizationId: string, itemId: string, action: 'reply' | 'repost' | 'quote', text?: string) {
    const clean = (text || '').trim();
    if (action !== 'repost' && !clean) throw new Error('Write something first');
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
            : buildRepost(target, relays);
        externalId = (await nostr.publish(relays, template, this.nostrSecret(integration))).id;
      } finally {
        nostr.close(relays);
      }
    } else if (item.platform === 'x') {
      if (action !== 'repost' && clean.length > 280) throw new Error('X posts are limited to 280 characters');
      const x = new XInbox(await this.token(integration));
      if (action === 'reply') externalId = await x.reply(item.externalId, clean);
      if (action === 'quote') externalId = await x.quote(item.externalId, clean);
      if (action === 'repost') await x.repost(integration.internalId, item.externalId);
      await this.addUsage('x-write', 1, { integration, kind: 'write' });
    } else {
      throw new Error('This channel does not support that yet');
    }

    const stamp = new Date();
    await this._prisma.inboxItem.update({
      where: { id: item.id },
      data: {
        readAt: item.readAt || stamp,
        ...(action === 'reply' ? { repliedAt: stamp } : action === 'quote' ? { quotedAt: stamp } : { repostedAt: stamp }),
      },
    });
    return { ok: true, externalId };
  }
}
