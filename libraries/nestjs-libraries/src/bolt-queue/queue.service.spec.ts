jest.mock('@gitroom/nestjs-libraries/database/prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.queries', () => ({ BoltAnalyticsQueries: class {}, SHRINK_POSTS: 5 }));
import { rankSuggestions } from './queue.service';

// Build a grid the way bestTimes does: overall average from all posts, and each
// slot's score pulled toward it by 5 posts' worth.
const grid = (cells: Array<[weekday: number, hour: number, posts: number, avg: number]>) => {
  const total = cells.reduce((s, c) => s + c[2] * c[3], 0);
  const n = cells.reduce((s, c) => s + c[2], 0);
  const overall = total / n;
  return cells.map(([weekday, hour, posts, avgEngagement]) => ({
    weekday,
    hour,
    posts,
    avgEngagement,
    score: (posts * avgEngagement + 5 * overall) / (posts + 5),
  }));
};

describe('queue suggestions', () => {
  it('prefers a time that has done well many times over two lucky posts', () => {
    const s = rankSuggestions(
      grid([
        [1, 9, 8, 40], // proven
        [1, 18, 2, 45], // two posts, slightly higher raw average
        [1, 7, 6, 10], // below average
        [1, 20, 1, 60], // single post: not enough
        [3, 14, 4, 5],
      ]),
      1
    );
    expect(s.filter((x) => x.day === 1).map((x) => x.minute / 60)).toEqual([9]);
  });

  it('only suggests slots above the average, and reports a cautious lift', () => {
    const s = rankSuggestions(
      grid([
        [1, 9, 8, 40],
        [1, 18, 2, 70],
        [1, 12, 2, 25],
        [1, 7, 6, 10],
        [2, 14, 3, 0],
      ])
    );
    const monday = s.filter((x) => x.day === 1).map((x) => x.minute / 60);
    expect(monday).toEqual([9, 18]); // 12 is below average once shrunk; 7 is below
    expect(s.find((x) => x.day === 2)).toBeUndefined();
    const lucky = s.find((x) => x.minute === 18 * 60)!;
    expect(lucky.avgEngagement).toBe(70);
    // raw would be 70/avg ≈ +200%; the shrunk score claims much less
    expect(lucky.lift).toBeGreaterThan(0);
    expect(lucky.lift).toBeLessThan(1);
  });

  it('copes with no data', () => {
    expect(rankSuggestions([])).toEqual([]);
  });
});
