import { fromAnalyticsData, summarize } from './metrics';

const point = (label: string, ...totals: Array<number | string>) => ({
  label,
  percentageChange: 0,
  data: totals.map((total, i) => ({ total: String(total), date: `2026-10-0${i + 1}` })),
});

describe('bolt analytics metrics', () => {
  it('maps X labels', () => {
    const s = summarize(
      fromAnalyticsData([
        point('Impressions', 1200),
        point('Likes', 30),
        point('Retweets', 4),
        point('Replies', 6),
        point('Quotes', 1),
        point('Bookmarks', 2),
      ])
    );
    expect(s.metrics).toEqual({ impressions: 1200, likes: 30, shares: 4, comments: 6, quotes: 1, saves: 2 });
    expect(s.impressions).toBe(1200);
    expect(s.engagement).toBe(43);
  });

  it('maps Facebook labels and skips its own engagement and click breakdown', () => {
    const s = summarize(
      fromAnalyticsData([
        point('Impressions', 500),
        point('Reactions', 12),
        point('Clicks', 9),
        point('Clicks by Type', 9),
        point('Engagement', 999),
      ])
    );
    expect(s.metrics).toEqual({ impressions: 500, likes: 12, clicks: 9 });
    expect(s.engagement).toBe(12);
  });

  it('uses views or reach when a platform has no impressions (Instagram)', () => {
    const s = summarize(fromAnalyticsData([point('Reach', 300), point('Likes', 5), point('Saves', 2), point('Shares', 1), point('Comments', 3)]));
    expect(s.impressions).toBe(300);
    expect(s.engagement).toBe(11);
  });

  it('sums LinkedIn daily series and ignores its engagement rate', () => {
    const s = summarize(
      fromAnalyticsData([
        point('Impressions', 100, 50),
        point('Unique Impressions', 80, 30),
        point('Likes', 3, 2),
        point('Engagement', '0.05', '0.04'),
      ])
    );
    expect(s.metrics).toEqual({ impressions: 150, reach: 110, likes: 5 });
    expect(s.engagement).toBe(5);
  });

  it('tolerates junk', () => {
    expect(fromAnalyticsData(undefined as any)).toEqual({});
    expect(fromAnalyticsData([point('Likes', 'n/a')])).toEqual({ likes: 0 });
  });
});
