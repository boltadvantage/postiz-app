// Bolt Advantage: X stats under a daily read budget. X bills per item read
// (~$0.005 per post, ~$0.01 per user lookup), so every call here is metered.
import { TwitterApi } from 'twitter-api-v2';
import type { MetricMap } from '@gitroom/nestjs-libraries/bolt-analytics/metrics';

// $1/day ≈ 200 post reads. Override with BOLT_X_DAILY_READS.
export const X_DAILY_READS = () => Math.max(0, Number(process.env.BOLT_X_DAILY_READS ?? 200));
export const X_USER_READ_COST = 2; // a user lookup costs about two post reads

const FIELDS = ['public_metrics', 'created_at'] as const;

export type XPost = { id: string; createdAt: Date; text: string; metrics: MetricMap };

export function metricsFromPublic(m: any): MetricMap {
  return {
    impressions: +m?.impression_count || 0,
    likes: +m?.like_count || 0,
    shares: +m?.retweet_count || 0,
    comments: +m?.reply_count || 0,
    quotes: +m?.quote_count || 0,
    saves: +m?.bookmark_count || 0,
  };
}

export class XAnalytics {
  private client: TwitterApi;

  constructor(token: string) {
    const [accessToken, accessSecret] = token.split(':');
    this.client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken,
      accessSecret,
    });
  }

  /** Current numbers for up to 100 posts per request; one read per post returned. */
  async lookup(ids: string[]) {
    const out: Record<string, MetricMap> = {};
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.client.v2.tweets(ids.slice(i, i + 100), { 'tweet.fields': [...FIELDS] });
      for (const t of res.data || []) {
        out[t.id] = metricsFromPublic(t.public_metrics);
      }
    }
    return out;
  }

  /**
   * One page of the user's own posts (no replies or reposts), newest first,
   * at most `max` posts so the page fits the remaining budget.
   */
  async timelinePage(userId: string, since: Date, max: number, paginationToken?: string) {
    const res = await this.client.v2.userTimeline(userId, {
      start_time: since.toISOString(),
      max_results: Math.min(100, Math.max(5, max)),
      exclude: ['replies', 'retweets'],
      'tweet.fields': [...FIELDS],
      ...(paginationToken ? { pagination_token: paginationToken } : {}),
    });
    const posts: XPost[] = (res.data?.data || []).map((t) => ({
      id: t.id,
      createdAt: new Date(t.created_at!),
      text: t.text,
      metrics: metricsFromPublic(t.public_metrics),
    }));
    return { posts, next: res.data?.meta?.next_token as string | undefined };
  }

  async followers() {
    const me = await this.client.v2.me({ 'user.fields': ['public_metrics'] });
    return me.data?.public_metrics?.followers_count ?? null;
  }
}
