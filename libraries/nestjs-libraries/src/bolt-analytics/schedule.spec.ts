import { byPriority, isDue } from './schedule';

const now = new Date('2026-11-01T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000);
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000);

describe('bolt analytics schedule', () => {
  it('always syncs a post that was never synced', () => {
    expect(isDue(daysAgo(2), null, now)).toBe(true);
    expect(isDue(daysAgo(200), null, now)).toBe(true);
  });

  it('refreshes young posts daily', () => {
    expect(isDue(daysAgo(3), hoursAgo(21), now)).toBe(true);
    expect(isDue(daysAgo(3), hoursAgo(10), now)).toBe(false);
  });

  it('refreshes 30-90 day posts weekly, then stops', () => {
    expect(isDue(daysAgo(45), daysAgo(2), now)).toBe(false);
    expect(isDue(daysAgo(45), daysAgo(7), now)).toBe(true);
    expect(isDue(daysAgo(120), daysAgo(30), now)).toBe(false);
  });

  it('never syncs a post scheduled in the future', () => {
    expect(isDue(new Date(now.getTime() + 3600 * 1000), null, now)).toBe(false);
  });

  it('puts the newest first', () => {
    const order = byPriority([{ publishedAt: daysAgo(5) }, { publishedAt: daysAgo(1) }, { publishedAt: daysAgo(9) }]);
    expect(order.map((p) => p.publishedAt)).toEqual([daysAgo(1), daysAgo(5), daysAgo(9)]);
  });
});
