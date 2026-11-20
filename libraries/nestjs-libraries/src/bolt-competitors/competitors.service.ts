// Bolt Advantage: competitors — accounts on X, Instagram or Nostr to watch,
// for any number of clients. Each account is tracked once per workspace
// (one set of reads, one history) and linked to every client watching it. On a schedule each workspace picks (daily to monthly): follower count, and their newest posts
// with engagement (ideas). Growth is compared with the client's own channels'
// saved follower counts. X reads come out of History's share of the X budget.
import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { dayKey } from '@gitroom/nestjs-libraries/bolt-analytics/schedule';
import { SUPPORTED_PROVIDERS } from '@gitroom/nestjs-libraries/bolt-analytics/providers';
import { chargeX, xBudgetLeft, xBudgetSettings } from '@gitroom/nestjs-libraries/bolt-costs/x-billing';
import {
  cleanHandle,
  COMPETITOR_PLATFORMS,
  CompetitorPlatform,
  instagramCompetitor,
  nostrCompetitor,
  POSTS_PER_CHECK,
  Profile,
  SeenPost,
  XCompetitors,
} from '@gitroom/nestjs-libraries/bolt-competitors/sources';

const CHECK_EVERY_H = 23;
/** How often a workspace's competitors are checked, in days. */
export const CHECK_EVERY_OPTIONS = [1, 3, 7, 14, 30] as const;
const settingKey = (organizationId: string) => `competitors-every:${organizationId}`;

/** Due when never checked, or last checked a whole period ago (an hour early, so the time of day doesn't creep). */
export function isDue(lastCheckAt: Date | null, everyDays: number, now = new Date()) {
  if (!lastCheckAt) return true;
  return now.getTime() - lastCheckAt.getTime() >= (everyDays * 24 - 1) * 3600_000;
}
const MANUAL_EVERY_MIN = 60;
const MAX_PER_ORG = 50;
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

type Row = { id: string; organizationId: string; platform: string; handle: string; externalId: string | null; createdAt: Date };

/**
 * Which tracked accounts are the same one twice (same platform, and the same
 * handle ignoring case, or the same platform id once looked up). Each group:
 * the oldest row stays, the rest fold into it.
 */
export function duplicateGroups<T extends Row>(rows: T[]): Array<{ keep: T; fold: T[] }> {
  const parent = new Map<string, string>(rows.map((r) => [r.id, r.id]));
  const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  const seen = new Map<string, string>();
  for (const r of rows) {
    for (const k of [`${r.organizationId}|${r.platform}|h:${r.handle.toLowerCase()}`, r.externalId ? `${r.organizationId}|${r.platform}|x:${r.externalId}` : '']) {
      if (!k) continue;
      if (seen.has(k)) join(r.id, seen.get(k)!);
      else seen.set(k, r.id);
    }
  }
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(find(r.id), [...(groups.get(find(r.id)) || []), r]);
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sorted = [...g].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      return { keep: sorted[0], fold: sorted.slice(1) };
    });
}

/** A competitor's (or channel's) growth between the first and last saved counts in a window. */
export function growth(points: Array<{ date: string; followers: number | null }>) {
  const known = points.filter((p) => p.followers !== null).sort((a, b) => a.date.localeCompare(b.date));
  if (!known.length) return { start: null, end: null, change: null, percent: null };
  const start = known[0].followers!;
  const end = known[known.length - 1].followers!;
  return { start, end, change: end - start, percent: start ? Math.round(((end - start) / start) * 1000) / 10 : null };
}

@Injectable()
export class CompetitorsService {
  private readonly _logger = new Logger('BoltCompetitors');

  constructor(private _prisma: PrismaService) {}

  // ---------- managing ----------

  async add(organizationId: string, input: { platform?: string; handle?: string; customerId?: string | null }) {
    const platform = String(input.platform || '') as CompetitorPlatform;
    if (!(COMPETITOR_PLATFORMS as readonly string[]).includes(platform)) throw new Error('Pick X, Instagram or Nostr');
    const handle = cleanHandle(platform, String(input.handle || '')).slice(0, 200);
    if (!handle) throw new Error('Enter their handle');
    const customerId = input.customerId || null;
    if (customerId && !(await this._prisma.customer.findFirst({ where: { id: customerId, orgId: organizationId, deletedAt: null } }))) {
      throw new Error('Client not found');
    }
    await this.consolidate(organizationId);
    // already tracked (maybe for another client): link it, don't track it twice
    const existing = await this._prisma.competitor.findFirst({
      where: { organizationId, platform, deletedAt: null, handle: { equals: handle, mode: 'insensitive' } },
    });
    if (existing) {
      if (!customerId) throw new Error('Already tracking that account');
      const linked = await this._prisma.competitorClient.findUnique({ where: { competitorId_customerId: { competitorId: existing.id, customerId } } });
      if (linked) throw new Error('Already tracking that account for this client');
      await this._prisma.competitorClient.create({ data: { competitorId: existing.id, customerId } });
      return { ...existing, shared: true };
    }
    if ((await this._prisma.competitor.count({ where: { organizationId, deletedAt: null } })) >= MAX_PER_ORG) {
      throw new Error(`Up to ${MAX_PER_ORG} competitors per workspace`);
    }
    const c = await this._prisma.competitor.create({ data: { organizationId, platform, handle } });
    if (customerId) await this._prisma.competitorClient.create({ data: { competitorId: c.id, customerId } });
    // look them up now so a wrong handle shows straight away
    await this.check(c.id).catch(() => undefined);
    // typed differently but the same account (e.g. npub vs name@domain): fold into the one already tracked
    await this.consolidate(organizationId);
    const after = await this._prisma.competitor.findUnique({ where: { id: c.id } });
    if (after?.deletedAt) {
      const kept = await this._prisma.competitor.findFirst({
        where: { organizationId, platform, deletedAt: null, externalId: after.externalId || '__none__' },
      });
      if (kept) return { ...kept, shared: true };
    }
    return after;
  }

  /**
   * Stop watching an account for one client, or (no client) altogether. The
   * account itself stops being checked once no client watches it.
   */
  async remove(organizationId: string, id: string, customerId?: string | null) {
    const c = await this._prisma.competitor.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!c) throw new Error('Not found');
    if (customerId) {
      await this._prisma.competitorClient.deleteMany({ where: { competitorId: id, customerId } });
      if (await this._prisma.competitorClient.count({ where: { competitorId: id } })) return { ok: true, stillTracked: true };
    }
    await this._prisma.competitorClient.deleteMany({ where: { competitorId: id } });
    await this._prisma.competitor.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true, stillTracked: false };
  }

  /**
   * Keep one row per account: move the old one-client field into links, and
   * fold accounts tracked more than once into the oldest (links, daily counts
   * and posts move over; the extra rows are retired). Safe to run any time.
   */
  async consolidate(organizationId: string) {
    const legacy = await this._prisma.competitor.findMany({ where: { organizationId, customerId: { not: null } }, select: { id: true, customerId: true } });
    if (legacy.length) {
      await this._prisma.competitorClient.createMany({ data: legacy.map((l) => ({ competitorId: l.id, customerId: l.customerId! })), skipDuplicates: true });
      await this._prisma.competitor.updateMany({ where: { id: { in: legacy.map((l) => l.id) } }, data: { customerId: null } });
    }
    const rows = await this._prisma.competitor.findMany({ where: { organizationId, deletedAt: null } });
    for (const { keep, fold } of duplicateGroups(rows)) {
      const foldIds = fold.map((f) => f.id);
      const links = await this._prisma.competitorClient.findMany({ where: { competitorId: { in: foldIds } } });
      if (links.length) {
        await this._prisma.competitorClient.createMany({ data: links.map((l) => ({ competitorId: keep.id, customerId: l.customerId })), skipDuplicates: true });
      }
      // history: the kept account's own counts win on days both have
      const have = new Set((await this._prisma.competitorDaily.findMany({ where: { competitorId: keep.id }, select: { date: true } })).map((d) => d.date));
      for (const d of await this._prisma.competitorDaily.findMany({ where: { competitorId: { in: foldIds } } })) {
        if (have.has(d.date)) continue;
        await this._prisma.competitorDaily.create({ data: { competitorId: keep.id, date: d.date, followers: d.followers, posts: d.posts } });
        have.add(d.date);
      }
      const known = new Set((await this._prisma.competitorPost.findMany({ where: { competitorId: keep.id }, select: { externalId: true } })).map((p) => p.externalId));
      for (const p of await this._prisma.competitorPost.findMany({ where: { competitorId: { in: foldIds } } })) {
        if (known.has(p.externalId)) continue;
        await this._prisma.competitorPost.update({ where: { id: p.id }, data: { competitorId: keep.id } });
        known.add(p.externalId);
      }
      const latest = [keep, ...fold].map((r: any) => r.lastCheckAt as Date | null).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
      const named = [keep, ...fold].find((r: any) => r.externalId) as any;
      await this._prisma.competitor.update({
        where: { id: keep.id },
        data: {
          lastCheckAt: latest || null,
          ...(!keep.externalId && named ? { externalId: named.externalId, name: named.name, picture: named.picture } : {}),
        },
      });
      await this._prisma.competitorClient.deleteMany({ where: { competitorId: { in: foldIds } } });
      await this._prisma.competitorDaily.deleteMany({ where: { competitorId: { in: foldIds } } });
      await this._prisma.competitorPost.deleteMany({ where: { competitorId: { in: foldIds } } });
      await this._prisma.competitor.updateMany({ where: { id: { in: foldIds } }, data: { deletedAt: new Date() } });
      this._logger.log(`merged ${fold.length} duplicate(s) of ${keep.platform} ${keep.handle}`);
    }
  }

  /** "Check now": at most once an hour per competitor (X costs money). */
  async checkNow(organizationId: string, id: string) {
    const c = await this._prisma.competitor.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!c) throw new Error('Not found');
    if (c.lastCheckAt && dayjs().diff(c.lastCheckAt, 'minute') < MANUAL_EVERY_MIN) throw new Error('Checked less than an hour ago');
    await this.check(c.id);
    return this._prisma.competitor.findUnique({ where: { id } });
  }

  // ---------- schedule ----------

  /** Days between automatic checks for this workspace (default: every day). */
  async checkEvery(organizationId: string) {
    const row = await this._prisma.boltSetting.findUnique({ where: { key: settingKey(organizationId) } });
    const n = Number(row?.value);
    return (CHECK_EVERY_OPTIONS as readonly number[]).includes(n) ? n : 1;
  }

  async setCheckEvery(organizationId: string, everyDays: unknown) {
    const n = Number(everyDays);
    if (!(CHECK_EVERY_OPTIONS as readonly number[]).includes(n)) throw new Error('Pick how often to check');
    await this._prisma.boltSetting.upsert({
      where: { key: settingKey(organizationId) },
      create: { key: settingKey(organizationId), value: String(n) },
      update: { value: String(n) },
    });
    return { everyDays: n };
  }

  // ---------- checking ----------

  /** Run from the inbox's 10-minute pass: anyone due under their workspace's schedule. */
  async syncDue() {
    const orgs = await this._prisma.competitor.findMany({ where: { deletedAt: null }, distinct: ['organizationId'], select: { organizationId: true } });
    for (const o of orgs) await this.consolidate(o.organizationId).catch((err) => this._logger.warn(`merge: ${err?.message || err}`));
    const candidates = await this._prisma.competitor.findMany({
      where: { deletedAt: null, OR: [{ lastCheckAt: null }, { lastCheckAt: { lt: dayjs().subtract(CHECK_EVERY_H, 'hour').toDate() } }] },
      orderBy: { lastCheckAt: { sort: 'asc', nulls: 'first' } },
      take: 500,
    });
    const every = new Map<string, number>();
    for (const org of new Set(candidates.map((c) => c.organizationId))) every.set(org, await this.checkEvery(org));
    const due = candidates.filter((c) => isDue(c.lastCheckAt, every.get(c.organizationId) || 1)).slice(0, 20);
    for (const c of due) {
      await this.check(c.id).catch((err) => this._logger.warn(`${c.platform} ${c.handle}: ${err?.message || err}`));
    }
  }

  /** The channel whose login reads this platform: the client's own, else any in the workspace. */
  private async readerChannel(organizationId: string, customerId: string | null, platform: 'x' | 'instagram') {
    const where = { organizationId, providerIdentifier: platform, deletedAt: null, disabled: false, refreshNeeded: false };
    return (
      (customerId ? await this._prisma.integration.findFirst({ where: { ...where, customerId }, orderBy: { createdAt: 'asc' } }) : null) ||
      (await this._prisma.integration.findFirst({ where, orderBy: { createdAt: 'asc' } }))
    );
  }

  private async firstClient(competitorId: string) {
    const link = await this._prisma.competitorClient.findFirst({ where: { competitorId }, orderBy: { createdAt: 'asc' } });
    return link?.customerId || null;
  }

  async check(id: string) {
    const c = await this._prisma.competitor.findUnique({ where: { id } });
    if (!c || c.deletedAt) return;
    let profile: Profile;
    let posts: SeenPost[] = [];
    try {
      if (c.platform === 'x') {
        const channel = await this.readerChannel(c.organizationId, await this.firstClient(id), 'x');
        if (!channel) throw new Error('Connect an X channel to track X accounts');
        const { prices } = await xBudgetSettings(this._prisma);
        if ((await xBudgetLeft(this._prisma, 'x')) < prices.user + POSTS_PER_CHECK * prices.post) {
          // not an error: try again on a later pass
          await this._prisma.competitor.update({ where: { id }, data: { lastError: "Waiting for today's X budget (History's share)" } });
          return;
        }
        const x = new XCompetitors(channel.token);
        profile = await x.profile(c.handle);
        await chargeX(this._prisma, channel, 'history', 'x', { users: [{ id: profile.externalId }] });
        const newest = await this._prisma.competitorPost.findFirst({ where: { competitorId: id }, orderBy: { publishedAt: 'desc' }, select: { externalId: true } });
        posts = await x.posts(profile.externalId, c.handle, newest?.externalId);
        await chargeX(this._prisma, channel, 'history', 'x', { posts: posts.map((p) => ({ id: p.externalId })) });
      } else if (c.platform === 'instagram') {
        const channel = await this.readerChannel(c.organizationId, await this.firstClient(id), 'instagram');
        if (!channel) throw new Error('Connect an Instagram (Facebook Business) channel to track Instagram accounts');
        ({ profile, posts } = await instagramCompetitor(channel.internalId, channel.token, c.handle));
      } else {
        ({ profile, posts } = await nostrCompetitor(c.handle));
      }
    } catch (err: any) {
      await this._prisma.competitor.update({ where: { id }, data: { lastCheckAt: new Date(), lastError: clip(err?.message || String(err), 500) } });
      throw err;
    }

    await this._prisma.competitor.update({
      where: { id },
      data: {
        externalId: profile.externalId,
        name: clip(profile.name, 200),
        picture: profile.picture && /^https:\/\//.test(profile.picture) ? clip(profile.picture, 1000) : null,
        lastCheckAt: new Date(),
        lastError: null,
      },
    });
    await this._prisma.competitorDaily.upsert({
      where: { competitorId_date: { competitorId: id, date: dayKey() } },
      create: { competitorId: id, date: dayKey(), followers: profile.followers, posts: profile.posts },
      update: { followers: profile.followers, posts: profile.posts },
    });
    for (const p of posts) {
      const data = { text: clip(p.text, 5000) || '', url: p.url || null, publishedAt: p.publishedAt, likes: p.likes, reposts: p.reposts, replies: p.replies };
      await this._prisma.competitorPost.upsert({
        where: { competitorId_externalId: { competitorId: id, externalId: p.externalId } },
        create: { competitorId: id, externalId: p.externalId, ...data },
        update: data,
      });
    }
  }

  // ---------- reading ----------

  async list(organizationId: string, opts: { customerId?: string; days?: number }) {
    const days = Math.min(365, Math.max(7, opts.days || 30));
    const since = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    await this.consolidate(organizationId).catch((err) => this._logger.warn(`merge: ${err?.message || err}`));
    const forClient = opts.customerId
      ? (await this._prisma.competitorClient.findMany({ where: { customerId: opts.customerId }, select: { competitorId: true } })).map((l) => l.competitorId)
      : null;
    const competitors = await this._prisma.competitor.findMany({
      where: { organizationId, deletedAt: null, ...(forClient ? { id: { in: forClient } } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const ids = competitors.map((c) => c.id);
    const links = await this._prisma.competitorClient.findMany({ where: { competitorId: { in: ids } } });
    const names = new Map(
      (await this._prisma.customer.findMany({ where: { id: { in: [...new Set(links.map((l) => l.customerId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])
    );
    const [daily, posts] = await Promise.all([
      this._prisma.competitorDaily.findMany({ where: { competitorId: { in: ids }, date: { gte: since } } }),
      this._prisma.competitorPost.findMany({ where: { competitorId: { in: ids }, publishedAt: { gte: dayjs().subtract(days, 'day').toDate() } } }),
    ]);
    return competitors.map((c) => {
      const points = daily.filter((d) => d.competitorId === c.id);
      const mine = posts.filter((p) => p.competitorId === c.id);
      const latest = [...points].sort((a, b) => b.date.localeCompare(a.date))[0];
      return {
        ...c,
        // every client watching this account (none = the workspace in general)
        clients: links.filter((l) => l.competitorId === c.id && names.has(l.customerId)).map((l) => ({ id: l.customerId, name: names.get(l.customerId)! })),
        followers: latest?.followers ?? null,
        growth: growth(points),
        history: points.sort((a, b) => a.date.localeCompare(b.date)).map((p) => ({ date: p.date, followers: p.followers })),
        postsInWindow: mine.length,
        // best first: what's worth borrowing ideas from
        topPosts: mine
          .sort((a, b) => b.likes + b.reposts * 2 + b.replies - (a.likes + a.reposts * 2 + a.replies))
          .slice(0, 10),
      };
    });
  }

  /** The client's own channels' follower growth over the same window, for comparison. */
  async ourGrowth(organizationId: string, opts: { customerId?: string; days?: number }) {
    const days = Math.min(365, Math.max(7, opts.days || 30));
    const since = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    const channels = await this._prisma.integration.findMany({
      where: {
        organizationId,
        deletedAt: null,
        disabled: false,
        type: 'social',
        providerIdentifier: { in: SUPPORTED_PROVIDERS },
        ...(opts.customerId ? { customerId: opts.customerId } : {}),
      },
      select: { id: true, name: true, picture: true, providerIdentifier: true },
    });
    const daily = await this._prisma.analyticsChannelDaily.findMany({
      where: { integrationId: { in: channels.map((c) => c.id) }, date: { gte: since } },
      select: { integrationId: true, date: true, followers: true },
    });
    // every channel shows, even before History has saved a count for it
    return channels.map((c) => ({ ...c, growth: growth(daily.filter((d) => d.integrationId === c.id)) }));
  }
}
