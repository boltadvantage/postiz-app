// Bolt Advantage: X inbox — mentions and replies under the daily read budget,
// and replying, reposting and quoting.
import { TwitterApi } from 'twitter-api-v2';
import type { InboxKind } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.inbox';

export type IncomingX = {
  id: string;
  kind: InboxKind;
  text: string;
  createdAt: Date;
  author: { id: string; handle?: string; name?: string; avatar?: string };
  targetId: string | null;
  targetText: string | null;
};

/** One mentions page → inbox items, plus how many billable items X returned. */
export function parseMentions(res: any) {
  const users = new Map<string, any>((res?.includes?.users || []).map((u: any) => [u.id, u]));
  const tweets = new Map<string, any>((res?.includes?.tweets || []).map((t: any) => [t.id, t]));
  const items: IncomingX[] = (res?.data || []).map((t: any) => {
    const refs: Array<{ type: string; id: string }> = t.referenced_tweets || [];
    const quoted = refs.find((r) => r.type === 'quoted');
    const replied = refs.find((r) => r.type === 'replied_to');
    const target = quoted || replied || null;
    const u = users.get(t.author_id) || {};
    return {
      id: t.id,
      kind: quoted ? 'quote' : replied ? 'reply' : 'mention',
      text: t.text || '',
      createdAt: new Date(t.created_at),
      author: { id: t.author_id, handle: u.username, name: u.name, avatar: u.profile_image_url },
      targetId: target?.id || null,
      targetText: target ? tweets.get(target.id)?.text || null : null,
    } as IncomingX;
  });
  const reads = (res?.data?.length || 0) + (res?.includes?.users?.length || 0) * 2 + (res?.includes?.tweets?.length || 0);
  return { items, reads, newestId: res?.meta?.newest_id as string | undefined };
}

export class XInbox {
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

  /** New mentions since `sinceId`; on the first run, only the last `firstRunDays` days. */
  async mentions(userId: string, opts: { sinceId?: string; max: number; firstRunDays?: number }) {
    const res = await this.client.v2.userMentionTimeline(userId, {
      max_results: Math.min(100, Math.max(5, opts.max)),
      ...(opts.sinceId
        ? { since_id: opts.sinceId }
        : { start_time: new Date(Date.now() - (opts.firstRunDays ?? 7) * 86400000).toISOString() }),
      expansions: ['author_id', 'referenced_tweets.id'],
      'tweet.fields': ['created_at', 'conversation_id', 'referenced_tweets', 'text'],
      'user.fields': ['username', 'name', 'profile_image_url'],
    });
    return parseMentions(res.data ? { data: res.data.data, includes: res.data.includes, meta: res.data.meta } : res);
  }

  async reply(tweetId: string, text: string) {
    const r = await this.client.v2.reply(text, tweetId);
    return r.data.id;
  }

  async repost(userId: string, tweetId: string) {
    await this.client.v2.retweet(userId, tweetId);
  }

  async quote(tweetId: string, text: string) {
    const r = await this.client.v2.tweet({ text, quote_tweet_id: tweetId });
    return r.data.id;
  }
}
