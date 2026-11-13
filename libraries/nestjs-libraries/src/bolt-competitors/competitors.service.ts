// Bolt Advantage: competitors — accounts on X, Instagram or Nostr to watch,
// optionally per client. Once a day: follower count, and their newest posts
// with engagement (ideas). Growth is compared with the client's own channels'
// saved follower counts. X reads come out of History's share of the X budget.
import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { dayKey } from '@gitroom/nestjs-libraries/bolt-analytics/schedule';
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
const MANUAL_EVERY_MIN = 60;
const MAX_PER_ORG = 50;
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

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
    if ((await this._prisma.competitor.count({ where: { organizationId, deletedAt: null } })) >= MAX_PER_ORG) {
      throw new Error(`Up to ${MAX_PER_ORG} competitors per workspace`);
    }
    const dupe = await this._prisma.competitor.findFirst({
      where: { organizationId, platform, customerId, deletedAt: null, handle: { equals: handle, mode: 'insensitive' } },
    });
    if (dupe) throw new Error('Already tracking that account');
    const c = await this._prisma.competitor.create({ data: { organizationId, platform, handle, customerId } });
    // look them up now so a wrong handle shows straight away
    await this.check(c.id).catch(() => undefined);
    return this._prisma.competitor.findUnique({ where: { id: c.id } });
  }

  async remove(organizationId: string, id: string) {
    const r = await this._prisma.competitor.updateMany({ where: { id, organizationId, deletedAt: null }, data: { deletedAt: new Date() } });
    if (!r.count) throw new Error('Not found');
    return { ok: true };
  }

  /** "Check now": at most once an hour per competitor (X costs money). */
  async checkNow(organizationId: string, id: string) {
    const c = await this._prisma.competitor.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!c) throw new Error('Not found');
    if (c.lastCheckAt && dayjs().diff(c.lastCheckAt, 'minute') < MANUAL_EVERY_MIN) throw new Error('Checked less than an hour ago');
    await this.check(c.id);
    return this._prisma.competitor.findUnique({ where: { id } });
  }

  // ---------- checking ----------

  /** Run from the inbox's 10-minute pass: anyone not checked for a day. */
  async syncDue() {
    const due = await this._prisma.competitor.findMany({
      where: { deletedAt: null, OR: [{ lastCheckAt: null }, { lastCheckAt: { lt: dayjs().subtract(CHECK_EVERY_H, 'hour').toDate() } }] },
      orderBy: { lastCheckAt: { sort: 'asc', nulls: 'first' } },
      take: 20,
    });
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

  async check(id: string) {
    const c = await this._prisma.competitor.findUnique({ where: { id } });
    if (!c || c.deletedAt) return;
    let profile: Profile;
    let posts: SeenPost[] = [];
    try {
      if (c.platform === 'x') {
        const channel = await this.readerChannel(c.organizationId, c.customerId, 'x');
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
        const channel = await this.readerChannel(c.organizationId, c.customerId, 'instagram');
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
    const competitors = await this._prisma.competitor.findMany({
      where: { organizationId, deletedAt: null, ...(opts.customerId ? { customerId: opts.customerId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const ids = competitors.map((c) => c.id);
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
      where: { organizationId, deletedAt: null, ...(opts.customerId ? { customerId: opts.customerId } : {}) },
      select: { id: true, name: true, picture: true, providerIdentifier: true },
    });
    const daily = await this._prisma.analyticsChannelDaily.findMany({
      where: { integrationId: { in: channels.map((c) => c.id) }, date: { gte: since } },
      select: { integrationId: true, date: true, followers: true },
    });
    return channels
      .map((c) => ({ ...c, growth: growth(daily.filter((d) => d.integrationId === c.id)) }))
      .filter((c) => c.growth.end !== null);
  }
}
