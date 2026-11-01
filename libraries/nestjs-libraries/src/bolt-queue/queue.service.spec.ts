jest.mock('@gitroom/nestjs-libraries/database/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.queries', () => ({ BoltAnalyticsQueries: class {} }));
import { rankSuggestions } from './queue.service';

describe('queue suggestions', () => {
  it('ranks each weekday’s best hours with lift vs the average and needs 2+ posts', () => {
    const grid = [
      { weekday: 1, hour: 9, posts: 4, avgEngagement: 30 },
      { weekday: 1, hour: 12, posts: 2, avgEngagement: 10 },
      { weekday: 1, hour: 18, posts: 1, avgEngagement: 500 }, // one lucky post: not suggested
      { weekday: 1, hour: 20, posts: 3, avgEngagement: 20 },
      { weekday: 1, hour: 7, posts: 2, avgEngagement: 5 }, // 4th best: dropped
      { weekday: 3, hour: 14, posts: 2, avgEngagement: 0 }, // zero engagement: not suggested
    ];
    const s = rankSuggestions(grid);
    expect(s.map((x) => [x.day, x.minute])).toEqual([
      [1, 9 * 60],
      [1, 12 * 60],
      [1, 20 * 60],
    ]);
    // weighted average = (120+20+500+60+10+0)/14 ≈ 50.7
    expect(s[0].lift).toBeCloseTo(30 / (710 / 14) - 1, 2);
    expect(s.find((x) => x.minute === 9 * 60)!.posts).toBe(4);
  });

  it('copes with no data', () => {
    expect(rankSuggestions([])).toEqual([]);
  });
});
