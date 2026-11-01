jest.mock('@gitroom/nestjs-libraries/database/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({ ioRedis: {} }));
jest.mock('@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.service', () => ({ LAST_RUN_KEY: 'k', SUPPORTED_PROVIDERS: [] }));
jest.mock('@gitroom/nestjs-libraries/bolt-analytics/x.analytics', () => ({ X_DAILY_READS: () => 200 }));
jest.mock('@gitroom/nestjs-libraries/bolt-analytics/schedule', () => ({ dayKey: () => '2026-11-01' }));
import { bestTimes, localSlot } from './bolt-analytics.queries';

describe('best times', () => {
  it('buckets by local weekday and hour, not UTC', () => {
    // Monday 2026-11-02 14:30 UTC = 08:30 in Chicago (CST, UTC-6)
    expect(localSlot(new Date('2026-11-02T14:30:00Z'), 'America/Chicago')).toEqual({ weekday: 1, hour: 8 });
    // Saturday 03:00 UTC = Friday 21:00 in Chicago
    expect(localSlot(new Date('2026-11-07T03:00:00Z'), 'America/Chicago')).toEqual({ weekday: 5, hour: 21 });
  });

  it('recommends the highest-average hours with enough posts', () => {
    const at = (iso: string, engagement: number) => ({ publishedAt: new Date(iso), engagement });
    const posts = [
      // Monday 8am Chicago: avg 20 over 2 posts
      at('2026-11-02T14:00:00Z', 10),
      at('2026-10-26T13:00:00Z', 30), // CDT week: 13:00Z = 8am
      // Monday noon: avg 5 over 2
      at('2026-11-02T18:00:00Z', 4),
      at('2026-10-26T17:00:00Z', 6),
      // Monday 6pm: one great post, but only one, so not recommended
      at('2026-11-03T00:00:00Z', 100),
    ];
    const r = bestTimes(posts, 'America/Chicago');
    expect(r.recommended[1]).toEqual([8, 12]);
    const monday8 = r.grid.find((g) => g.weekday === 1 && g.hour === 8)!;
    expect(monday8).toMatchObject({ weekday: 1, hour: 8, posts: 2 });
    // 10 and 30 a week apart: weighted toward the newer 10, so a bit under 20
    expect(monday8.avgEngagement).toBeGreaterThan(15);
    expect(monday8.avgEngagement).toBeLessThan(20);
    expect(r.sampleSize).toBe(5);
    expect(r.recommended[0]).toEqual([]);
  });
});

describe('follower growth', () => {
  const { followerGrowth } = jest.requireActual('./bolt-analytics.queries');
  it('is last total minus first total in the period, ignoring missing days', () => {
    const g = followerGrowth(
      [
        { date: '2026-09-30', followers: 10 }, // before the period
        { date: '2026-10-02', followers: 100 },
        { date: '2026-10-03', followers: null },
        { date: '2026-10-09', followers: 112 },
      ],
      '2026-10-01'
    );
    expect(g).toMatchObject({ followers: 112, followersChange: 12, followersChangePct: 12, trackingSince: '2026-10-02' });
    expect(g.followersDaily).toHaveLength(2);
  });

  it('a single day of data has a total but no change yet', () => {
    expect(followerGrowth([{ date: '2026-11-01', followers: 50 }], '2026-10-01')).toMatchObject({
      followers: 50,
      followersChange: null,
      followersChangePct: null,
      trackingSince: '2026-11-01',
    });
  });

  it('no data', () => {
    expect(followerGrowth([], '2026-10-01').followers).toBeNull();
  });
});

describe('best times recency', () => {
  it('weights recent posts more (30-day half-life)', () => {
    const now = new Date('2026-11-02T18:00:00Z');
    const at = (daysAgo: number, engagement: number) => ({ publishedAt: new Date(now.getTime() - daysAgo * 86400000), engagement });
    // same Monday-noon slot (Chicago): an old big post and a recent small one
    const r = bestTimes([at(63, 100), at(7, 10)], 'America/Chicago', 2, 3, now);
    const cell = r.grid[0];
    // unweighted would be 55; weighted leans toward the recent 10
    expect(cell.avgEngagement).toBeLessThan(40);
    expect(cell.avgEngagement).toBeGreaterThan(10);
    expect(cell.posts).toBe(2);
  });
});
