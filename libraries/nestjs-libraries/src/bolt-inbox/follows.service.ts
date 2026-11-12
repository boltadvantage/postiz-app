// Bolt Advantage: who followed (and on Nostr, unfollowed) each channel, for the
// inbox's Follows tab. Off per channel until turned on; each channel can show
// only notable followers (verified, or at least N followers of their own).
import { Injectable, Logger } from '@nestjs/common';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { isLocked, withLock } from '@gitroom/nestjs-libraries/redis/bolt.lock';
import { InboxService, X_MIN_CHECK_USD } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { NostrInbox } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.inbox';
import { XInbox } from '@gitroom/nestjs-libraries/bolt-inbox/x.inbox';
import { xBudgetSettings } from '@gitroom/nestjs-libraries/bolt-costs/x-billing';
import { nostrFollowers } from '@gitroom/nestjs-libraries/bolt-analytics/followers';
import {
  followSettings,
  FOLLOW_PLATFORMS,
  followsSelf,
  newestLists,
  nostrFollowersFrom,
  notableWhere,
  verifyNip05,
  withFollow,
} from '@gitroom/nestjs-libraries/bolt-inbox/follows';

const LOCK_KEY = 'bolt-follows:lock';
const PAGE = 50;
// X: one cheap follower-count read per check; the list is only read when it grows
const X_MIN_INTERVAL_MIN = 60;
const X_EXTRA = 5;
// Nostr: looking up new followers' follower counts goes through Primal, one call each
const NOSTR_LOOKUPS_PER_RUN = 50;
const NOSTR_FIRST_RUN_LIMIT = 2000;
const NOSTR_UNFOLLOW_EVERY_H = 6;

export const followCursorId = (integrationId: string) => `follows:${integrationId}`;
const dropCursorId = (integrationId: string) => `follows-drop:${integrationId}`;

export type FollowFilters = { integrationIds?: string[]; status?: 'unread' | 'open' | 'archived' | 'all'; showMuted?: boolean; tag?: string; q?: string; page?: number };

@Injectable()
export class FollowsService {
  private readonly _logger = new Logger('BoltFollows');

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
          providerIdentifier: { in: FOLLOW_PLATFORMS },
          ...(organizationId ? { organizationId } : {}),
        },
      });
      const settings = new Map<string, Awaited<ReturnType<typeof followSettings>>>();
      for (const integration of integrations) {
        if (!settings.has(integration.organizationId)) settings.set(integration.organizationId, await followSettings(this._prisma, integration.organizationId));
        if (!settings.get(integration.organizationId)![integration.id]?.on) continue;
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

  private async record(
    integration: Integration,
    f: { authorId: string; event: 'follow' | 'unfollow'; at: Date; followers: number | null; verified: boolean; seen?: boolean }
  ) {
    const other = f.event === 'follow' ? 'unfollow' : 'follow';
    // a follow replaces an earlier unfollow and the other way round
    await this._prisma.inboxFollow.deleteMany({ where: { integrationId: integration.id, authorId: f.authorId, event: other } });
    const stamp = f.seen ? new Date() : null;
    await this._prisma.inboxFollow.upsert({
      where: { integrationId_authorId_event: { integrationId: integration.id, authorId: f.authorId, event: f.event } },
      create: {
        organizationId: integration.organizationId,
        integrationId: integration.id,
        platform: integration.providerIdentifier,
        authorId: f.authorId,
        event: f.event,
        followers: f.followers,
        verified: f.verified,
        at: f.at,
        readAt: stamp,
        archivedAt: stamp,
      },
      update: {},
    });
  }

  private async syncX(integration: Integration, force: boolean) {
    const id = followCursorId(integration.id);
    const state = await this._inbox.cursor(id);
    if (!force && state?.lastRunAt && dayjs().diff(state.lastRunAt, 'minute') < X_MIN_INTERVAL_MIN) return;
    const budget = await this._inbox.xBudgetLeft();
    if (budget < X_MIN_CHECK_USD) return;
    const x = new XInbox(await this._inbox.token(integration));
    const count = await x.followerCount(integration.internalId);
    await this._inbox.charge(integration, 'inbox', 'x-inbox', { users: [{ id: integration.internalId, own: true }] });
    if (count === null) return;
    const before = state?.cursor ? Number(state.cursor) : null;
    // first check: remember the total; only followers after this show up
    if (before !== null && count > before) {
      const { prices } = await xBudgetSettings(this._prisma);
      const max = Math.min(count - before + X_EXTRA, Math.floor((budget - prices.user) / prices.user));
      if (max < 1) return; // not enough left today; the next check tries again
      const followers = await x.followers(integration.internalId, max);
      await this._inbox.charge(integration, 'inbox', 'x-inbox', { users: followers.map((u) => ({ id: u.id })) });
      const known = new Set(
        (await this._prisma.inboxFollow.findMany({ where: { integrationId: integration.id, event: 'follow', authorId: { in: followers.map((u) => u.id) } }, select: { authorId: true } })).map((r) => r.authorId)
      );
      for (const u of followers.filter((f) => !known.has(f.id))) {
        await this._inbox.upsertPerson(integration.organizationId, 'x', u.id, u);
        await this.record(integration, { authorId: u.id, event: 'follow', at: new Date(), followers: u.followers, verified: u.verified });
      }
    }
    await this._inbox.saveCursor(id, { cursor: String(count) });
  }

  private async syncNostr(integration: Integration) {
    const id = followCursorId(integration.id);
    const state = await this._inbox.cursor(id);
    const firstRun = !state?.since;
    const self = integration.internalId;
    const nostr = new NostrInbox();
    const relays = await nostr.relays(self);
    try {
      const events = await nostr.followLists(relays, self, state?.since || new Date(0));
      const lists = nostrFollowersFrom(firstRun ? events.slice(0, NOSTR_FIRST_RUN_LIMIT) : events, self);
      const known = new Set(
        (await this._prisma.inboxFollow.findMany({ where: { integrationId: integration.id, event: 'follow', authorId: { in: lists.map((e) => e.pubkey) } }, select: { authorId: true } })).map((r) => r.authorId)
      );
      const fresh = lists.filter((e) => !known.has(e.pubkey)).sort((a, b) => b.created_at - a.created_at);
      const profiles = await nostr.profiles(relays, fresh.map((e) => e.pubkey));
      for (const [i, e] of fresh.entries()) {
        const p = profiles.get(e.pubkey) || {};
        await this._inbox.upsertPerson(integration.organizationId, 'nostr', e.pubkey, p);
        // the first check records who already follows without filling the inbox with them
        const look = !firstRun && i < NOSTR_LOOKUPS_PER_RUN;
        const followers = look ? await nostrFollowers(e.pubkey).then((r) => r.followers, () => null) : null;
        const verified = look ? await verifyNip05(p.handle?.includes('@') ? p.handle : undefined, e.pubkey) : false;
        await this.record(integration, { authorId: e.pubkey, event: 'follow', at: new Date(e.created_at * 1000), followers, verified, seen: firstRun });
      }
      const newest = events.reduce((m, e) => Math.max(m, e.created_at), Math.floor((state?.since?.getTime() || 0) / 1000));
      await this._inbox.saveCursor(id, { since: new Date(Math.max(0, newest - 120) * 1000) });
      await this.unfollows(integration, nostr, relays);
    } finally {
      nostr.close(relays);
    }
  }

  /** Every few hours: did any of the people following this channel drop it from their list? */
  private async unfollows(integration: Integration, nostr: NostrInbox, relays: string[]) {
    const id = dropCursorId(integration.id);
    const state = await this._inbox.cursor(id);
    if (state?.lastRunAt && dayjs().diff(state.lastRunAt, 'hour') < NOSTR_UNFOLLOW_EVERY_H) return;
    const follows = await this._prisma.inboxFollow.findMany({ where: { integrationId: integration.id, event: 'follow' }, select: { authorId: true, at: true } });
    const lists = newestLists(await nostr.listsOf(relays, follows.map((f) => f.authorId)));
    for (const f of follows) {
      const list = lists.get(f.authorId);
      if (!list || list.created_at * 1000 <= f.at.getTime() || followsSelf(list, integration.internalId)) continue;
      const prev = await this._prisma.inboxFollow.findUnique({ where: { integrationId_authorId_event: { integrationId: integration.id, authorId: f.authorId, event: 'follow' } } });
      await this.record(integration, { authorId: f.authorId, event: 'unfollow', at: new Date(list.created_at * 1000), followers: prev?.followers ?? null, verified: !!prev?.verified });
    }
    await this._inbox.saveCursor(id, {});
  }

  // ---------- reading ----------

  /** Rows that pass each switched-on channel's filter (and the user's own filters). */
  private async where(organizationId: string, f: FollowFilters & { unreadOnly?: boolean }) {
    const settings = await followSettings(this._prisma, organizationId);
    const on = Object.entries(settings).filter(([id, s]) => s.on && (!f.integrationIds?.length || f.integrationIds.includes(id)));
    if (!on.length) return null;
    const people = await this._prisma.inboxPerson.findMany({ where: { organizationId, platform: { in: FOLLOW_PLATFORMS } } });
    const and: any[] = [{ OR: on.map(([id, s]) => notableWhere(id, s)) }];
    const muted = people.filter((p) => p.muted);
    if (!f.showMuted && muted.length) and.push({ NOT: { OR: muted.map((p) => ({ platform: p.platform, authorId: p.authorId })) } });
    if (f.tag) {
      const tagged = people.filter((p) => p.tags.toLowerCase().includes(`"${f.tag!.toLowerCase()}"`));
      and.push(tagged.length ? { OR: tagged.map((p) => ({ platform: p.platform, authorId: p.authorId })) } : { id: '__none__' });
    }
    if (f.q) {
      const q = f.q.toLowerCase();
      const hits = people.filter((p) => `${p.name || ''} ${p.handle || ''}`.toLowerCase().includes(q));
      and.push(hits.length ? { OR: hits.map((p) => ({ platform: p.platform, authorId: p.authorId })) } : { id: '__none__' });
    }
    const status = f.unreadOnly ? 'unread' : f.status || 'open';
    return {
      organizationId,
      ...(status === 'unread' ? { readAt: null, archivedAt: null } : status === 'open' ? { archivedAt: null } : status === 'archived' ? { archivedAt: { not: null } } : {}),
      AND: and,
    };
  }

  async list(organizationId: string, f: FollowFilters) {
    const where = await this.where(organizationId, f);
    if (!where) return { total: 0, pages: 0, items: [] as any[], off: true };
    const page = Math.max(0, f.page || 0);
    const [total, rows] = await Promise.all([
      this._prisma.inboxFollow.count({ where }),
      this._prisma.inboxFollow.findMany({ where, orderBy: { at: 'desc' }, skip: page * PAGE, take: PAGE }),
    ]);
    const people = await this._prisma.inboxPerson.findMany({ where: { organizationId, OR: rows.map((r) => ({ platform: r.platform, authorId: r.authorId })) } });
    const byKey = new Map(people.map((p) => [`${p.platform}:${p.authorId}`, { ...p, tags: JSON.parse(p.tags || '[]') }]));
    return { total, pages: Math.ceil(total / PAGE), items: rows.map((r) => ({ ...r, person: byKey.get(`${r.platform}:${r.authorId}`) || null })), off: false };
  }

  async unreadCount(organizationId: string) {
    const where = await this.where(organizationId, { unreadOnly: true });
    return where ? this._prisma.inboxFollow.count({ where }) : 0;
  }

  async mark(organizationId: string, ids: string[], action: 'read' | 'unread' | 'archive' | 'unarchive') {
    const data =
      action === 'read' ? { readAt: new Date() } : action === 'unread' ? { readAt: null } : action === 'archive' ? { archivedAt: new Date(), readAt: new Date() } : { archivedAt: null };
    const r = await this._prisma.inboxFollow.updateMany({ where: { organizationId, id: { in: ids.slice(0, 500) } }, data });
    return { updated: r.count };
  }

  async remove(organizationId: string, ids: string[]) {
    const r = await this._prisma.inboxFollow.deleteMany({ where: { organizationId, id: { in: ids.slice(0, 500) } } });
    return { deleted: r.count };
  }

  settings(organizationId: string) {
    return followSettings(this._prisma, organizationId);
  }

  // ---------- following back ----------

  async followBack(organizationId: string, id: string) {
    const follow = await this._prisma.inboxFollow.findFirst({ where: { id, organizationId } });
    if (!follow) throw new Error('Not found');
    await this.follow(organizationId, follow.integrationId, follow.authorId);
    const stamp = new Date();
    await this._prisma.inboxFollow.update({ where: { id: follow.id }, data: { followedBackAt: stamp, readAt: follow.readAt || stamp } });
    return { ok: true };
  }

  /** Follow someone the inbox knows (InboxPerson id) from one of the org's X or Nostr channels. */
  async followPerson(organizationId: string, integrationId: string, personId: string) {
    const person = await this._prisma.inboxPerson.findFirst({ where: { id: personId, organizationId } });
    if (!person) throw new Error('Person not found');
    const integration = await this._prisma.integration.findFirst({ where: { id: integrationId, organizationId, deletedAt: null } });
    if (!integration) throw new Error('Channel not found');
    if (integration.providerIdentifier !== person.platform) throw new Error(`That person is on ${person.platform}, not ${integration.providerIdentifier}`);
    await this.follow(organizationId, integrationId, person.authorId);
    // if they already follow this channel, show it as followed back
    await this._prisma.inboxFollow.updateMany({ where: { integrationId, authorId: person.authorId, event: 'follow', followedBackAt: null }, data: { followedBackAt: new Date() } });
    return { ok: true };
  }

  private async follow(organizationId: string, integrationId: string, authorId: string) {
    const integration = await this._prisma.integration.findFirst({ where: { id: integrationId, organizationId, deletedAt: null } });
    if (!integration) throw new Error('That channel is no longer connected');
    if (integration.internalId === authorId) throw new Error("A channel can't follow itself");
    if (integration.providerIdentifier === 'x') {
      const x = new XInbox(await this._inbox.token(integration));
      await x.follow(integration.internalId, authorId);
      await this._inbox.charge(integration, 'write', 'x-write', { writes: 1 });
    } else if (integration.providerIdentifier === 'nostr') {
      const nostr = new NostrInbox();
      const relays = await nostr.relays(integration.internalId);
      try {
        // publishing replaces the whole list, so start from the newest one the relays have
        const mine = newestLists(await nostr.listsOf(relays, [integration.internalId])).get(integration.internalId);
        if (!mine) throw new Error("Couldn't find your current follow list on your relays, so following from here could erase it. Follow them from a Nostr app instead.");
        if (!followsSelf(mine, authorId)) await nostr.publish(relays, withFollow(mine, authorId), this._inbox.nostrSecret(integration));
      } finally {
        nostr.close(relays);
      }
    } else {
      throw new Error('Following works on X and Nostr channels');
    }
  }
}

