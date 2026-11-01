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
    expect(r.grid.find((g) => g.weekday === 1 && g.hour === 8)).toEqual({ weekday: 1, hour: 8, posts: 2, avgEngagement: 20 });
    expect(r.sampleSize).toBe(5);
    expect(r.recommended[0]).toEqual([]);
  });
});
