// Bolt Advantage: Instagram inbox — comments (and replies to comments) on the
// account's recent posts, and posts where someone tagged the account in the
// photo. Uses the linked Page's token that an "Instagram (Facebook Business)"
// channel holds (instagram_manage_comments). Meta doesn't charge for these.
// @mentions in other people's captions and comments only arrive by webhook,
// so they aren't here.
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { pageToken, unreachable } from '@gitroom/nestjs-libraries/bolt-inbox/meta.dm';

const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
export const IG_POST_DAYS = 30;
const POSTS = 25;
const COMMENTS_PER_POST = 50;
const TAGS = 25;

export type IncomingInstagram = {
  id: string;
  kind: 'reply' | 'mention';
  text: string;
  createdAt: Date;
  url: string;
  /** Instagram usernames are what every endpoint here agrees on */
  author: { id: string; handle: string };
  targetId: string;
  targetText: string | null;
  /** comments are one level deep: replies go on the top-level comment; tags can't be replied to */
  threadId: string | null;
};

/** Recent posts with their comments → other people's comments newer than `since`. */
export function parseComments(res: any, self: { id: string; username?: string }, since: Date) {
  const items: IncomingInstagram[] = [];
  let newest = since.getTime();
  for (const post of res?.data || []) {
    const top: any[] = post?.comments?.data || [];
    const all = top.flatMap((c) => [{ c, parent: null as any }, ...(c.replies?.data || []).map((r: any) => ({ c: r, parent: c }))]);
    for (const { c, parent } of all) {
      const at = Date.parse(c.timestamp);
      if (!Number.isFinite(at) || at <= since.getTime()) continue;
      newest = Math.max(newest, at);
      const username = c.from?.username || c.username;
      if (!username || c.from?.id === self.id || (self.username && username === self.username)) continue;
      items.push({
        id: String(c.id),
        kind: 'reply',
        text: c.text || '',
        createdAt: new Date(at),
        url: post.permalink || 'https://www.instagram.com/',
        author: { id: username, handle: username },
        targetId: parent ? String(parent.id) : String(post.id),
        targetText: (parent ? parent.text : post.caption) || null,
        threadId: String(parent?.id || c.id),
      });
    }
  }
  items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { items, newest: new Date(newest) };
}

/** Posts the account is tagged in → mentions newer than `since`. */
export function parseTags(res: any, since: Date) {
  const items: IncomingInstagram[] = [];
  let newest = since.getTime();
  for (const m of res?.data || []) {
    const at = Date.parse(m.timestamp);
    if (!Number.isFinite(at) || at <= since.getTime() || !m.username) continue;
    newest = Math.max(newest, at);
    items.push({
      id: `tag:${m.id}`,
      kind: 'mention',
      text: m.caption || '[tagged you in a post]',
      createdAt: new Date(at),
      url: m.permalink || 'https://www.instagram.com/',
      author: { id: m.username, handle: m.username },
      targetId: String(m.id),
      targetText: null,
      threadId: null,
    });
  }
  return { items, newest: new Date(newest) };
}

const graphError = (body: any, fallback: string) => {
  const e = body?.error;
  if (!e) return new Error(`Instagram: ${fallback}`);
  if (e.code === 10 || e.code === 200 || e.code === 190) {
    return new Error(`Instagram refused (${e.message}). Reconnect Instagram in Postiz.`);
  }
  return new Error(`Instagram: ${e.message || fallback}`);
};

export class InstagramInbox {
  constructor(private igUserId: string, private token: string) {}

  private async call(path: string, init?: RequestInit) {
    const url = `${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(pageToken(this.token))}`;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw unreachable('Instagram', err);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) throw graphError(body, `HTTP ${res.status}`);
    return body;
  }

  /** New comments on the account's posts from the last IG_POST_DAYS days, in one request. */
  async comments(since: Date, self: { id: string; username?: string }) {
    const comment = 'id,text,timestamp,username,from{id,username}';
    const fields = `id,caption,permalink,timestamp,comments.limit(${COMMENTS_PER_POST}){${comment},replies.limit(${COMMENTS_PER_POST}){${comment}}}`;
    const res = await this.call(`${this.igUserId}/media?fields=${encodeURIComponent(fields)}&limit=${POSTS}`);
    // a post older than the window won't be looked at; the list is newest first
    const cutoff = Date.now() - IG_POST_DAYS * 86400_000;
    res.data = (res.data || []).filter((p: any) => Date.parse(p.timestamp) >= cutoff);
    return parseComments(res, self, since);
  }

  /** Posts where someone tagged this account. */
  async tags(since: Date) {
    const res = await this.call(`${this.igUserId}/tags?fields=${encodeURIComponent('id,caption,permalink,timestamp,username')}&limit=${TAGS}`);
    return parseTags(res, since);
  }

  /**
   * Comment on someone else's post that @mentions this account in its caption.
   * Instagram allows this only for caption @mentions, not for photo tags alone.
   */
  async replyToMention(mediaId: string, text: string) {
    const body = await this.call(`${this.igUserId}/mentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: mediaId, message: text }),
    });
    return String(body?.id || '') || null;
  }

  async reply(commentId: string, text: string) {
    const body = await this.call(`${commentId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    return String(body?.id || '') || null;
  }
}
