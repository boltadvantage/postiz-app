// Bolt Advantage: direct messages in the inbox — one-to-one conversations on
// Nostr (NIP-04 and NIP-17) and X, sharing the inbox's people, tags and mutes.
import { Injectable, Logger } from '@nestjs/common';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { isLocked, withLock } from '@gitroom/nestjs-libraries/redis/bolt.lock';
import { INBOX_PROVIDERS, InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { NostrInbox, secretKeyFromHex } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.inbox';
import { DmProtocol, NostrDms } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.dm';
import { isDmPermissionError, XDms, xIdAfter } from '@gitroom/nestjs-libraries/bolt-inbox/x.inbox';
import { worstItem, xBudgetSettings } from '@gitroom/nestjs-libraries/bolt-costs/x-billing';
import { switchChecker } from '@gitroom/nestjs-libraries/bolt-inbox/switches';
import { META_DM_LIMIT, MetaDmError, MetaDms, MetaPlatform } from '@gitroom/nestjs-libraries/bolt-inbox/meta.dm';

const LOCK_KEY = 'bolt-dm:lock';
const FIRST_RUN_DAYS = 14;
// Facebook and Instagram only allow replies within 24 hours, so older messages aren't worth bringing in
const META_FIRST_RUN_HOURS = 24;
const X_MIN_INTERVAL_MIN = 30;
const X_MAX_READS_PER_RUN = 20;
// left untouched by DM checks so mentions can always run
const X_MENTIONS_RESERVE_USD = 0.05;
const X_DM_PERMISSION =
  'X needs Direct Message permission. In the X developer portal, set your app to "Read and write and Direct message", then reconnect X here.';
const PAGE = 40;

const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);
export const dmCursorId = (integrationId: string) => `dm:${integrationId}`;

type Incoming = {
  externalId: string;
  peer: string;
  direction: 'in' | 'out';
  text: string;
  sentAt: Date;
  protocol: string | null;
};

@Injectable()
export class DmService {
  private readonly _logger = new Logger('BoltDm');

  constructor(
    private _prisma: PrismaService,
    private _inbox: InboxService
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
      const isOff = switchChecker(this._prisma, 'messages');
      for (const integration of integrations) {
        try {
          if (await isOff(integration)) continue;
          if (integration.providerIdentifier === 'nostr') await this.syncNostr(integration);
          if (integration.providerIdentifier === 'x') await this.syncX(integration, force);
          if (integration.providerIdentifier === 'facebook' || integration.providerIdentifier === 'instagram') await this.syncMeta(integration);
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

  /** Save messages we don't have yet; muted people's messages are never saved. */
  async store(integration: Integration, messages: Incoming[], people: Map<string, { handle?: string; name?: string; avatar?: string }>) {
    const platform = integration.providerIdentifier;
    const muted = await this._inbox.mutedAuthors(integration.organizationId, platform);
    let added = 0;
    for (const m of messages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
      if (muted.has(m.peer)) continue;
      const exists = await this._prisma.inboxMessage.findUnique({
        where: { integrationId_externalId: { integrationId: integration.id, externalId: m.externalId } },
        select: { id: true },
      });
      if (exists) continue;
      await this._inbox.upsertPerson(integration.organizationId, platform, m.peer, people.get(m.peer) || {});
      const convo = await this._prisma.inboxConversation.upsert({
        where: { integrationId_peerId: { integrationId: integration.id, peerId: m.peer } },
        create: {
          organizationId: integration.organizationId,
          integrationId: integration.id,
          platform,
          peerId: m.peer,
          lastMessageAt: m.sentAt,
        },
        update: {},
      });
      await this._prisma.inboxMessage.create({
        data: {
          organizationId: integration.organizationId,
          conversationId: convo.id,
          integrationId: integration.id,
          externalId: m.externalId,
          direction: m.direction,
          content: clip(m.text, 10000) || '',
          protocol: m.protocol,
          sentAt: m.sentAt,
        },
      });
      const newest = m.sentAt >= convo.lastMessageAt;
      await this._prisma.inboxConversation.update({
        where: { id: convo.id },
        data: {
          ...(newest ? { lastMessageAt: m.sentAt, lastPreview: clip(m.text, 200), lastDirection: m.direction } : {}),
          // answer in whatever they last wrote in
          ...(m.direction === 'in' && m.protocol ? { protocol: m.protocol } : {}),
          // a new message from them brings an archived conversation back; one from us means we've seen it
          ...(m.direction === 'in' ? { unread: { increment: 1 }, archivedAt: null } : newest ? { unread: 0 } : {}),
        },
      });
      added += 1;
    }
    return added;
  }

  private async syncNostr(integration: Integration) {
    const cursorId = dmCursorId(integration.id);
    const state = await this._inbox.cursor(cursorId);
    const since = state?.since || dayjs().subtract(FIRST_RUN_DAYS, 'day').toDate();
    const secret = this._inbox.nostrSecret(integration);
    const sk = secretKeyFromHex(secret);
    const inbox = new NostrInbox();
    const dms = new NostrDms();
    const relays = [...new Set([...(await inbox.relays(integration.internalId)), ...(await dms.dmRelays(integration.internalId))])];
    try {
      const found = await dms.fetch(relays, integration.internalId, sk, since);
      const peers = [...new Set(found.map((m) => m.peer))];
      const profiles = peers.length ? await inbox.profiles(relays, peers) : new Map();
      await this.store(
        integration,
        found.map((m) => ({ externalId: m.id, peer: m.peer, direction: m.direction, text: m.text, sentAt: new Date(m.at * 1000), protocol: m.protocol })),
        profiles
      );
      const newest = found.reduce((n, m) => Math.max(n, m.at), Math.floor(since.getTime() / 1000));
      await this._inbox.saveCursor(cursorId, { since: new Date((newest - 120) * 1000), error: null });
    } finally {
      inbox.close(relays);
      dms.close(relays);
    }
  }

  private async syncX(integration: Integration, force: boolean) {
    const cursorId = dmCursorId(integration.id);
    const state = await this._inbox.cursor(cursorId);
    if (!force && state?.lastRunAt && dayjs().diff(state.lastRunAt, 'minute') < X_MIN_INTERVAL_MIN) return;
    // mentions come first; DMs take at most half of what's left of the inbox's share
    // dollars → items: half of what's left after keeping some for mentions, at the worst case per message
    const { prices } = await xBudgetSettings(this._prisma);
    const usd = ((await this._inbox.xBudgetLeft()) - X_MENTIONS_RESERVE_USD) / 2;
    const budget = Math.min(X_MAX_READS_PER_RUN, Math.floor(usd / (worstItem(prices, 'dm') / 2)));
    if (budget < 2) return;
    const x = new XDms(await this._inbox.token(integration));
    try {
      const res = await x.since(integration.internalId, {
        afterId: state?.cursor,
        budget,
        oldest: state?.cursor ? dayjs().subtract(30, 'day').toDate() : dayjs().subtract(FIRST_RUN_DAYS, 'day').toDate(),
      });
      await this._inbox.charge(integration, 'dm', 'x-inbox', res.resources);
      await this.store(
        integration,
        res.messages.map((m) => ({ externalId: m.id, peer: m.peer, direction: m.direction, text: m.text, sentAt: m.createdAt, protocol: null })),
        res.people
      );
      const newest = [...res.messages.map((m) => m.id), ...(res.newestId ? [res.newestId] : [])].reduce<string | null>(
        (n, id) => (xIdAfter(id, n) ? id : n),
        state?.cursor || null
      );
      await this._inbox.saveCursor(cursorId, { cursor: newest, error: null });
    } catch (err: any) {
      if (isDmPermissionError(err)) {
        await this._inbox.saveCursor(cursorId, { cursor: state?.cursor || null, error: X_DM_PERMISSION });
        return;
      }
      throw err;
    }
  }

  /** Facebook Page and Instagram messages: free, so checked every pass. */
  private async syncMeta(integration: Integration) {
    const cursorId = dmCursorId(integration.id);
    const state = await this._inbox.cursor(cursorId);
    const since = state?.since || dayjs().subtract(META_FIRST_RUN_HOURS, 'hour').toDate();
    const meta = new MetaDms(integration.providerIdentifier as MetaPlatform, await this._inbox.token(integration));
    try {
      const res = await meta.since(integration.internalId, since);
      await this.store(
        integration,
        res.messages.map((m) => ({ externalId: m.id, peer: m.peer, direction: m.direction, text: m.text, sentAt: m.createdAt, protocol: null })),
        res.people
      );
      // a little overlap: a conversation's time can land just before its newest message is visible
      await this._inbox.saveCursor(cursorId, { since: new Date(res.newest.getTime() - 120_000), error: null });
    } catch (err: any) {
      if (err instanceof MetaDmError) {
        await this._inbox.saveCursor(cursorId, { since, error: clip(err.message, 500) });
        return;
      }
      throw err;
    }
  }

  // ---------- reading ----------

  private async hiddenPeers(organizationId: string) {
    return this._prisma.inboxPerson.findMany({ where: { organizationId, muted: true }, select: { platform: true, authorId: true } });
  }

  async conversations(
    organizationId: string,
    f: { integrationIds?: string[]; status?: 'open' | 'unread' | 'archived' | 'all'; tag?: string; showMuted?: boolean; q?: string; page?: number }
  ) {
    const people = await this._prisma.inboxPerson.findMany({ where: { organizationId } });
    const key = (platform: string, id: string) => `${platform}:${id}`;
    const parse = (s: string) => {
      try {
        return JSON.parse(s || '[]') as string[];
      } catch {
        return [];
      }
    };
    const byKey = new Map(people.map((p) => [key(p.platform, p.authorId), { ...p, tags: parse(p.tags) }]));
    const and: any[] = [];
    const muted = people.filter((p) => p.muted);
    if (!f.showMuted && muted.length) and.push({ NOT: { OR: muted.map((p) => ({ platform: p.platform, peerId: p.authorId })) } });
    if (f.tag) {
      const tagged = people.filter((p) => parse(p.tags).includes(f.tag!.toLowerCase()));
      and.push(tagged.length ? { OR: tagged.map((p) => ({ platform: p.platform, peerId: p.authorId })) } : { id: '__none__' });
    }
    if (f.q) {
      const matchPeople = people
        .filter((p) => `${p.name || ''} ${p.handle || ''}`.toLowerCase().includes(f.q!.toLowerCase()))
        .map((p) => ({ platform: p.platform, peerId: p.authorId }));
      const matchMessages = await this._prisma.inboxMessage.findMany({
        where: { organizationId, content: { contains: f.q, mode: 'insensitive' } },
        select: { conversationId: true },
        distinct: ['conversationId'],
        take: 500,
      });
      and.push({ OR: [...matchPeople, { id: { in: matchMessages.map((m) => m.conversationId) } }] });
    }
    const status = f.status || 'open';
    const where: any = {
      organizationId,
      ...(f.integrationIds?.length ? { integrationId: { in: f.integrationIds } } : {}),
      ...(status === 'unread' ? { unread: { gt: 0 }, archivedAt: null } : status === 'open' ? { archivedAt: null } : status === 'archived' ? { archivedAt: { not: null } } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const page = Math.max(0, f.page || 0);
    const [total, rows] = await Promise.all([
      this._prisma.inboxConversation.count({ where }),
      this._prisma.inboxConversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, skip: page * PAGE, take: PAGE }),
    ]);
    return {
      total,
      pages: Math.ceil(total / PAGE),
      conversations: rows.map((c) => ({ ...c, person: byKey.get(key(c.platform, c.peerId)) || null })),
    };
  }

  private async conversation(organizationId: string, id: string) {
    const c = await this._prisma.inboxConversation.findFirst({ where: { id, organizationId } });
    if (!c) throw new Error('Conversation not found');
    return c;
  }

  /** Messages oldest-first; `before` pages back through older ones. Opening it marks it read unless `markRead` is false (bots reading shouldn't clear your unread). */
  async messages(organizationId: string, id: string, before?: string, markRead = true) {
    const c = await this.conversation(organizationId, id);
    const rows = await this._prisma.inboxMessage.findMany({
      where: { conversationId: c.id, ...(before ? { sentAt: { lt: new Date(before) } } : {}) },
      orderBy: { sentAt: 'desc' },
      take: 100,
    });
    if (markRead && c.unread && !before) await this._prisma.inboxConversation.update({ where: { id: c.id }, data: { unread: 0 } });
    return { conversation: markRead ? { ...c, unread: 0 } : c, messages: rows.reverse(), more: rows.length === 100 };
  }

  async mark(organizationId: string, ids: string[], action: 'read' | 'unread' | 'archive' | 'unarchive') {
    const where = { organizationId, id: { in: ids.slice(0, 500) } };
    if (action === 'unread') {
      // only conversations they've written in can be unread
      const r = await this._prisma.inboxConversation.updateMany({ where: { ...where, unread: 0 }, data: { unread: 1 } });
      return { updated: r.count };
    }
    const data = action === 'read' ? { unread: 0 } : action === 'archive' ? { archivedAt: new Date(), unread: 0 } : { archivedAt: null };
    const r = await this._prisma.inboxConversation.updateMany({ where, data });
    return { updated: r.count };
  }

  /** Removes conversations and their messages from the inbox only; nothing changes on the social network. */
  async remove(organizationId: string, ids: string[]) {
    const own = await this._prisma.inboxConversation.findMany({ where: { organizationId, id: { in: ids.slice(0, 500) } }, select: { id: true } });
    const conversationIds = own.map((c) => c.id);
    if (!conversationIds.length) return { deleted: 0 };
    await this._prisma.inboxMessage.deleteMany({ where: { organizationId, conversationId: { in: conversationIds } } });
    const r = await this._prisma.inboxConversation.deleteMany({ where: { organizationId, id: { in: conversationIds } } });
    return { deleted: r.count };
  }

  async unreadCount(organizationId: string) {
    const muted = await this.hiddenPeers(organizationId);
    const r = await this._prisma.inboxConversation.aggregate({
      where: {
        organizationId,
        archivedAt: null,
        unread: { gt: 0 },
        ...(muted.length ? { NOT: { OR: muted.map((p) => ({ platform: p.platform, peerId: p.authorId })) } } : {}),
      },
      _count: { _all: true },
    });
    return r._count._all;
  }

  /** Sync problems worth showing (e.g. X missing DM permission), by channel. */
  async problems(organizationId: string) {
    const channels = await this._prisma.integration.findMany({
      where: { organizationId, deletedAt: null, providerIdentifier: { in: INBOX_PROVIDERS } },
      select: { id: true, updatedAt: true },
    });
    const rows = await this._prisma.inboxCursor.findMany({
      where: { integrationId: { in: channels.map((c) => dmCursorId(c.id)) }, error: { not: null } },
    });
    const changed = new Map(channels.map((c) => [dmCursorId(c.id), c.updatedAt]));
    // a reconnect after the failed check may already have fixed it; the next check will say
    const current = rows.filter((r) => !r.lastRunAt || r.lastRunAt >= (changed.get(r.integrationId) || new Date(0)));
    return Object.fromEntries(current.map((r) => [r.integrationId.slice(3), r.error]));
  }

  // ---------- sending ----------

  async send(organizationId: string, id: string, text: string) {
    const clean = (text || '').trim();
    if (!clean) throw new Error('Write something first');
    const c = await this.conversation(organizationId, id);
    const integration = await this._prisma.integration.findFirst({ where: { id: c.integrationId, organizationId, deletedAt: null } });
    if (!integration) throw new Error('That channel is no longer connected');

    let externalId: string;
    let sentAt = new Date();
    let protocol: string | null = null;
    if (c.platform === 'nostr') {
      protocol = (c.protocol as DmProtocol) || 'nip17';
      const inbox = new NostrInbox();
      const dms = new NostrDms();
      const relays = await inbox.relays(integration.internalId);
      try {
        const r = await dms.send({ relays, secretHex: this._inbox.nostrSecret(integration), peer: c.peerId, text: clean, protocol: protocol as DmProtocol });
        externalId = r.id;
        sentAt = new Date(r.at * 1000);
      } finally {
        inbox.close(relays);
        dms.close(relays);
      }
    } else if (c.platform === 'x') {
      if (clean.length > 10000) throw new Error('X messages are limited to 10,000 characters');
      const x = new XDms(await this._inbox.token(integration));
      try {
        externalId = (await x.send(c.peerId, clean)).id;
      } catch (err: any) {
        if (isDmPermissionError(err)) throw new Error(X_DM_PERMISSION);
        throw err;
      }
      await this._inbox.charge(integration, 'write', 'x-write', { writes: 1 });
    } else if (c.platform === 'facebook' || c.platform === 'instagram') {
      const limit = META_DM_LIMIT[c.platform];
      if (clean.length > limit) throw new Error(`${c.platform === 'facebook' ? 'Messenger' : 'Instagram'} messages are limited to ${limit.toLocaleString()} characters`);
      externalId = await new MetaDms(c.platform, await this._inbox.token(integration)).send(c.peerId, clean);
    } else {
      throw new Error('This channel does not support messages yet');
    }

    const message = await this._prisma.inboxMessage.upsert({
      where: { integrationId_externalId: { integrationId: integration.id, externalId } },
      create: { organizationId, conversationId: c.id, integrationId: integration.id, externalId, direction: 'out', content: clean, protocol, sentAt },
      update: {},
    });
    await this._prisma.inboxConversation.update({
      where: { id: c.id },
      data: { lastMessageAt: sentAt, lastPreview: clip(clean, 200), lastDirection: 'out', unread: 0 },
    });
    return message;
  }
}
