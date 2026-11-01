// Bolt Advantage: turn each platform's own metric labels into one comparable shape.
import type { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

export type MetricMap = Record<string, number>;

// Platform label -> our key. Labels not listed are kept as-is (snake_cased).
const KEYS: Record<string, string> = {
  impressions: 'impressions',
  'unique impressions': 'reach',
  reach: 'reach',
  views: 'views',
  plays: 'views',
  likes: 'likes',
  reactions: 'likes',
  replies: 'comments',
  comments: 'comments',
  retweets: 'shares',
  reposts: 'shares',
  shares: 'shares',
  quotes: 'quotes',
  bookmarks: 'saves',
  saves: 'saves',
  clicks: 'clicks',
  zaps: 'zaps',
  'zap sats': 'zap_sats',
};

// Platform-computed rates/aggregates we don't store; we compute engagement ourselves
// (LinkedIn's "Engagement" is a rate, Facebook's/Instagram's are inconsistent totals).
const SKIP = new Set(['engagement', 'clicks by type']);

/** Interactions that count toward one cross-platform engagement number. */
export const ENGAGEMENT_KEYS = ['likes', 'comments', 'shares', 'quotes', 'saves', 'zaps'];

export function keyFor(label: string) {
  const l = label.trim().toLowerCase();
  return KEYS[l] || l.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** A provider's AnalyticsData[] -> a flat map. Multi-point series (LinkedIn daily) are summed. */
export function fromAnalyticsData(data: AnalyticsData[]): MetricMap {
  const out: MetricMap = {};
  for (const item of data || []) {
    if (!item?.label || SKIP.has(item.label.trim().toLowerCase())) {
      continue;
    }
    const total = (item.data || []).reduce((sum, point) => {
      const n = Number(point?.total);
      return Number.isFinite(n) ? sum + n : sum;
    }, 0);
    const key = keyFor(item.label);
    out[key] = (out[key] || 0) + Math.round(total);
  }
  return out;
}

export function engagementOf(metrics: MetricMap) {
  return ENGAGEMENT_KEYS.reduce((sum, k) => sum + (metrics[k] || 0), 0);
}

/** Best available "how many people saw it" number for the platform. */
export function impressionsOf(metrics: MetricMap) {
  return metrics.impressions || metrics.views || metrics.reach || 0;
}

export function summarize(metrics: MetricMap) {
  return {
    metrics,
    impressions: impressionsOf(metrics),
    engagement: engagementOf(metrics),
  };
}
