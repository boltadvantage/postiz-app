// Bolt Advantage: X inbox — mentions and replies under the daily read budget,
// and replying, reposting, quoting and liking.
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

  async like(userId: string, tweetId: string) {
    await this.client.v2.like(userId, tweetId);
  }

  async quote(tweetId: string, text: string) {
    const r = await this.client.v2.tweet({ text, quote_tweet_id: tweetId });
    return r.data.id;
  }
}

export type XDm = {
  id: string;
  peer: string;
  direction: 'in' | 'out';
  text: string;
  createdAt: Date;
  conversationId: string;
};

/** Newer-than for X ids (snowflakes, too big for Number). */
export const xIdAfter = (a: string, b?: string | null) => !b || BigInt(a) > BigInt(b);

/**
 * One dm_events page → one-to-one messages newer than `afterId`, the people in
 * them, and how many billable items X returned. Group conversations are skipped.
 */
export function parseDmEvents(res: any, self: string, afterId?: string | null) {
  const users = new Map<string, any>((res?.includes?.users || []).map((u: any) => [u.id, u]));
  const messages: XDm[] = [];
  let reachedKnown = false;
  for (const e of res?.data || []) {
    if (!xIdAfter(e.id, afterId)) {
      reachedKnown = true;
      continue;
    }
    if (e.event_type && e.event_type !== 'MessageCreate') continue;
    // one-to-one conversation ids are "<smaller id>-<larger id>"
    const pair = String(e.dm_conversation_id || '').split('-');
    if (pair.length !== 2 || !pair.includes(self)) continue;
    const peer = pair[0] === self ? pair[1] : pair[0];
    messages.push({
      id: e.id,
      peer,
      direction: e.sender_id === self ? 'out' : 'in',
      text: e.text || '',
      createdAt: new Date(e.created_at),
      conversationId: e.dm_conversation_id,
    });
  }
  const people = new Map(
    [...users.values()].map((u) => [u.id, { id: u.id, handle: u.username, name: u.name, avatar: u.profile_image_url }])
  );
  const reads = (res?.data?.length || 0) + (res?.includes?.users?.length || 0);
  // newest event of any kind (group chats included), so the cursor moves past it
  const newestId = (res?.data?.[0]?.id as string | undefined) || undefined;
  return { messages, people, reads, reachedKnown, newestId, nextToken: res?.meta?.next_token as string | undefined };
}

/** X answers 403 when the app or the connection lacks Direct Message permission. */
export const isDmPermissionError = (err: any) => err?.code === 403 || err?.data?.status === 403;

export class XDms {
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

  /**
   * Newest-first pages until we reach what we already have, run out of budget, or pass `oldest`.
   * X has no "newer than" filter for DMs and bills every event it returns, so with a
   * cursor the first page is a single event: if that one is known, the check costs ~2 reads.
   */
  async since(self: string, opts: { afterId?: string | null; budget: number; oldest: Date }) {
    const messages: XDm[] = [];
    const people = new Map<string, { id: string; handle?: string; name?: string; avatar?: string }>();
    let reads = 0;
    let token: string | undefined;
    let newestId: string | undefined;
    while (reads < opts.budget) {
      const peek = !!opts.afterId && !token;
      const res = await this.client.v2.get('dm_events', {
        max_results: peek ? 1 : Math.min(100, Math.max(1, opts.budget - reads)),
        event_types: 'MessageCreate',
        'dm_event.fields': 'id,text,event_type,dm_conversation_id,created_at,sender_id',
        expansions: 'sender_id',
        'user.fields': 'username,name,profile_image_url',
        ...(token ? { pagination_token: token } : {}),
      });
      const page = parseDmEvents(res, self, opts.afterId);
      newestId = newestId || page.newestId;
      reads += Math.max(1, page.reads);
      messages.push(...page.messages);
      page.people.forEach((v, k) => people.set(k, v));
      const oldestOnPage = page.messages[page.messages.length - 1]?.createdAt;
      token = page.nextToken;
      if (page.reachedKnown || !token || (oldestOnPage && oldestOnPage < opts.oldest)) break;
    }
    return { messages: messages.filter((m) => m.createdAt >= opts.oldest), people, reads, newestId };
  }

  async send(peerId: string, text: string) {
    const r = await this.client.v2.sendDmToParticipant(peerId, { text });
    return { id: r.dm_event_id, conversationId: r.dm_conversation_id };
  }
}
