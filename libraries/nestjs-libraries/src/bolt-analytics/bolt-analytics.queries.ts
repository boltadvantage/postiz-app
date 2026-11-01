// Bolt Advantage: read side of saved analytics (summary, posts, best times, CSV).
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { LAST_RUN_KEY, SUPPORTED_PROVIDERS } from '@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.service';
import { X_DAILY_READS } from '@gitroom/nestjs-libraries/bolt-analytics/x.analytics';
import { dayKey } from '@gitroom/nestjs-libraries/bolt-analytics/schedule';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday (0=Sun) and hour (0-23) of a date in an IANA timezone. */
export function localSlot(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')!.value);
  const hour = +parts.find((p) => p.type === 'hour')!.value % 24;
  return { weekday, hour };
}

export type SlotStat = { weekday: number; hour: number; posts: number; avgEngagement: number };

/**
 * Average engagement per weekday x hour, and the best hours per weekday.
 * A slot needs at least `minPosts` posts before it can be recommended.
 */
export function bestTimes(
  posts: Array<{ publishedAt: Date; engagement: number }>,
  timeZone: string,
  minPosts = 2,
  perDay = 3
) {
  const cells = new Map<string, { weekday: number; hour: number; posts: number; total: number }>();
  for (const p of posts) {
    const { weekday, hour } = localSlot(p.publishedAt, timeZone);
    const key = `${weekday}:${hour}`;
    const c = cells.get(key) || { weekday, hour, posts: 0, total: 0 };
    c.posts += 1;
    c.total += p.engagement;
    cells.set(key, c);
  }
  const grid: SlotStat[] = [...cells.values()].map((c) => ({
    weekday: c.weekday,
    hour: c.hour,
    posts: c.posts,
    avgEngagement: Math.round((c.total / c.posts) * 10) / 10,
  }));
  const recommended = WEEKDAYS.map((_, weekday) =>
    grid
      .filter((g) => g.weekday === weekday && g.posts >= minPosts)
      .sort((a, b) => b.avgEngagement - a.avgEngagement || b.posts - a.posts)
      .slice(0, perDay)
      .map((g) => g.hour)
      .sort((a, b) => a - b)
  );
  return { grid, recommended, sampleSize: posts.length };
}

/**
 * Follower growth over a period from the daily TOTALS only: last total minus the
 * first total on or after `fromDate`. Days without a real total are ignored.
 */
export function followerGrowth(rows: Array<{ date: string; followers: number | null }>, fromDate: string) {
  const inPeriod = rows
    .filter((r) => r.followers != null && r.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!inPeriod.length) {
    return { followers: null, followersChange: null, followersChangePct: null, trackingSince: null, followersDaily: [] };
  }
  const first = inPeriod[0].followers as number;
  const last = inPeriod[inPeriod.length - 1].followers as number;
  const change = inPeriod.length > 1 ? last - first : null;
  return {
    followers: last,
    followersChange: change,
    followersChangePct: change != null && first > 0 ? Math.round((change / first) * 1000) / 10 : null,
    trackingSince: inPeriod[0].date,
    followersDaily: inPeriod.map((r) => ({ date: r.date, followers: r.followers as number })),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

@Injectable()
export class BoltAnalyticsQueries {
  constructor(private _prisma: PrismaService) {}

  private channels(organizationId: string) {
    return this._prisma.integration.findMany({
      where: { organizationId, deletedAt: null, type: 'social', providerIdentifier: { in: SUPPORTED_PROVIDERS } },
      select: { id: true, name: true, picture: true, providerIdentifier: true, disabled: true },
    });
  }

  async status(organizationId: string, running: boolean) {
    const [lastRun, xReads, posts] = await Promise.all([
      ioRedis.get(LAST_RUN_KEY),
      this._prisma.analyticsApiUsage.findUnique({ where: { provider_date: { provider: 'x', date: dayKey() } } }),
      this._prisma.analyticsPost.count({ where: { organizationId } }),
    ]);
    return {
      running,
      lastRun,
      savedPosts: posts,
      xReadsToday: xReads?.reads || 0,
      xDailyReads: X_DAILY_READS(),
      // ~$0.005 per post read
      xSpendToday: Math.round((xReads?.reads || 0) * 0.5) / 100,
    };
  }

  /** Per channel: totals for the period, the previous period for comparison, followers, daily series. */
  async summary(organizationId: string, days: number) {
    const from = dayjs().subtract(days, 'day').startOf('day').toDate();
    const prevFrom = dayjs(from).subtract(days, 'day').toDate();
    const channels = await this.channels(organizationId);
    const posts = await this._prisma.analyticsPost.findMany({
      where: { organizationId, publishedAt: { gte: prevFrom } },
      select: { integrationId: true, publishedAt: true, impressions: true, engagement: true, lastSyncedAt: true },
    });
    const followers = await this._prisma.analyticsChannelDaily.findMany({
      where: { organizationId, date: { gte: dayKey(prevFrom) } },
      orderBy: { date: 'asc' },
      select: { integrationId: true, date: true, followers: true },
    });

    return channels.map((ch) => {
      const mine = posts.filter((p) => p.integrationId === ch.id);
      const cur = mine.filter((p) => p.publishedAt >= from);
      const prev = mine.filter((p) => p.publishedAt < from);
      const sum = (list: typeof mine, k: 'impressions' | 'engagement') => list.reduce((s, p) => s + p[k], 0);
      const daily = new Map<string, { date: string; posts: number; engagement: number; impressions: number }>();
      for (const p of cur) {
        const d = dayKey(p.publishedAt);
        const row = daily.get(d) || { date: d, posts: 0, engagement: 0, impressions: 0 };
        row.posts += 1;
        row.engagement += p.engagement;
        row.impressions += p.impressions;
        daily.set(d, row);
      }
      const growth = followerGrowth(
        followers.filter((r) => r.integrationId === ch.id),
        dayKey(from)
      );
      return {
        integration: ch,
        posts: cur.length,
        impressions: sum(cur, 'impressions'),
        engagement: sum(cur, 'engagement'),
        avgEngagement: cur.length ? Math.round((sum(cur, 'engagement') / cur.length) * 10) / 10 : 0,
        previous: { posts: prev.length, impressions: sum(prev, 'impressions'), engagement: sum(prev, 'engagement') },
        ...growth,
        synced: cur.filter((p) => p.lastSyncedAt).length,
        daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      };
    });
  }

  async posts(
    organizationId: string,
    opts: { integrationId?: string; days: number; sort: 'engagement' | 'impressions' | 'date'; page: number }
  ) {
    const where = {
      organizationId,
      publishedAt: { gte: dayjs().subtract(opts.days, 'day').toDate() },
      ...(opts.integrationId ? { integrationId: opts.integrationId } : {}),
    };
    const orderBy =
      opts.sort === 'date'
        ? { publishedAt: 'desc' as const }
        : opts.sort === 'impressions'
        ? { impressions: 'desc' as const }
        : { engagement: 'desc' as const };
    const [total, rows] = await Promise.all([
      this._prisma.analyticsPost.count({ where }),
      this._prisma.analyticsPost.findMany({ where, orderBy, skip: opts.page * 50, take: 50 }),
    ]);
    return {
      total,
      pages: Math.ceil(total / 50),
      posts: rows.map((r) => ({ ...r, metrics: JSON.parse(r.metrics || '{}') })),
    };
  }

  async bestTimes(organizationId: string, integrationId: string | undefined, timeZone: string) {
    const posts = await this._prisma.analyticsPost.findMany({
      where: {
        organizationId,
        lastSyncedAt: { not: null },
        publishedAt: { gte: dayjs().subtract(90, 'day').toDate() },
        ...(integrationId ? { integrationId } : {}),
      },
      select: { publishedAt: true, engagement: true },
    });
    return { timeZone, ...bestTimes(posts, timeZone) };
  }

  /** One row per channel per day with a real follower total. */
  async followersCsv(organizationId: string, days: number) {
    const channels = new Map((await this.channels(organizationId)).map((c) => [c.id, c]));
    const rows = await this._prisma.analyticsChannelDaily.findMany({
      where: { organizationId, followers: { not: null }, date: { gte: dayKey(dayjs().subtract(days, 'day').toDate()) } },
      orderBy: [{ date: 'asc' }, { integrationId: 'asc' }],
      select: { integrationId: true, date: true, followers: true },
    });
    const lines = rows
      .filter((r) => channels.has(r.integrationId))
      .map((r) => {
        const ch = channels.get(r.integrationId)!;
        return [r.date, ch.name, ch.providerIdentifier, r.followers].map(csvCell).join(',');
      });
    return ['date,channel,platform,followers', ...lines].join('\n') + '\n';
  }

  async csv(organizationId: string, days: number) {
    const channels = new Map((await this.channels(organizationId)).map((c) => [c.id, c]));
    const rows = await this._prisma.analyticsPost.findMany({
      where: { organizationId, publishedAt: { gte: dayjs().subtract(days, 'day').toDate() } },
      orderBy: { publishedAt: 'desc' },
    });
    const keys = ['impressions', 'reach', 'views', 'likes', 'comments', 'shares', 'quotes', 'saves', 'clicks', 'zaps', 'zap_sats'];
    const header = ['published_at', 'channel', 'platform', 'source', 'engagement', ...keys, 'url', 'text', 'last_synced_at'];
    const lines = rows.map((r) => {
      const m = JSON.parse(r.metrics || '{}');
      const ch = channels.get(r.integrationId);
      return [
        r.publishedAt.toISOString(),
        ch?.name,
        ch?.providerIdentifier,
        r.source,
        r.engagement,
        ...keys.map((k) => m[k] ?? ''),
        r.url,
        r.content,
        r.lastSyncedAt?.toISOString(),
      ]
        .map(csvCell)
        .join(',');
    });
    return [header.join(','), ...lines].join('\n') + '\n';
  }
}
