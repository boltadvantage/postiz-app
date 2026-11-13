// Bolt Advantage: Facebook Page inbox — comments (and replies to comments) on
// the Page's recent posts, and replying to or liking them. Uses the Page token
// Postiz already holds (pages_read_engagement + pages_manage_engagement), and
// costs nothing: Meta doesn't charge for the Graph API, it only rate-limits.
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { unreachable } from '@gitroom/nestjs-libraries/bolt-inbox/meta.dm';

const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
/** How far back to look for posts that may have new comments. */
export const FB_POST_DAYS = 30;
const POSTS = 25;
const COMMENTS_PER_POST = 50;

export type IncomingFacebook = {
  id: string;
  text: string;
  createdAt: Date;
  url: string;
  author: { id: string; name?: string };
  /** the comment it answers, or the Page post for a top-level comment */
  targetId: string;
  targetText: string | null;
  /** Facebook threads are one level deep: replies go on the top-level comment */
  threadId: string;
};

/** The feed answer → comments by other people newer than `since`, oldest first. */
export function parseFeed(res: any, pageId: string, since: Date) {
  const items: IncomingFacebook[] = [];
  let newest = since.getTime();
  for (const post of res?.data || []) {
    const comments: any[] = post?.comments?.data || [];
    const byId = new Map(comments.map((c) => [c.id, c]));
    for (const c of comments) {
      const at = new Date(c.created_time).getTime();
      if (!Number.isFinite(at) || at <= since.getTime()) continue;
      newest = Math.max(newest, at);
      // the Page's own comments and replies aren't inbox items
      if (!c.from?.id || c.from.id === pageId) continue;
      const parent = c.parent?.id ? byId.get(c.parent.id) || c.parent : null;
      items.push({
        id: c.id,
        text: c.message || (c.attachment ? '[attachment]' : ''),
        createdAt: new Date(at),
        url: c.permalink_url || post.permalink_url || `https://www.facebook.com/${c.id}`,
        author: { id: c.from.id, name: c.from.name },
        targetId: parent?.id || post.id,
        targetText: (parent ? parent.message : post.message) || null,
        threadId: parent?.id || c.id,
      });
    }
  }
  items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { items, newest: new Date(newest) };
}

/** Graph API errors come back as JSON with an `error` object. */
const graphError = (body: any, fallback: string) => {
  const e = body?.error;
  if (!e) return new Error(fallback);
  if (e.code === 10 || e.code === 200 || e.code === 190) {
    return new Error(`Facebook refused (${e.message}). Reconnect this Page in Postiz.`);
  }
  return new Error(`Facebook: ${e.message || fallback}`);
};

export class FacebookInbox {
  constructor(private pageId: string, private token: string) {}

  private async call(path: string, init?: RequestInit) {
    const url = `${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token)}`;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw unreachable('Facebook', err);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) throw graphError(body, `HTTP ${res.status}`);
    return body;
  }

  /**
   * New comments on the Page's posts from the last FB_POST_DAYS days. A busy
   * Page's posts-with-comments in one request can take Facebook longer than
   * the timeout, so: list recent posts (small), then read comments only for
   * posts with activity since the last check, one post at a time.
   */
  async comments(since: Date) {
    const postsSince = Math.floor((Date.now() - FB_POST_DAYS * 86400_000) / 1000);
    const list = await this.call(`${this.pageId}/feed?fields=${encodeURIComponent('id,message,permalink_url,updated_time')}&limit=${POSTS}&since=${postsSince}`);
    // a post's updated_time moves when someone comments on it
    const active = (list?.data || []).filter((p: any) => !p.updated_time || Date.parse(p.updated_time) > since.getTime() - 60_000);
    const commentFields = 'id,message,created_time,permalink_url,attachment{type},from{id,name},parent{id,message}';
    const after = Math.floor(since.getTime() / 1000) - 60;
    for (const post of active) {
      const res = await this.call(
        `${post.id}/comments?filter=stream&order=reverse_chronological&limit=${COMMENTS_PER_POST}&since=${after}&fields=${encodeURIComponent(commentFields)}`
      );
      post.comments = { data: res?.data || [] };
    }
    return parseFeed({ data: active }, this.pageId, since);
  }

  async reply(commentId: string, text: string) {
    const body = await this.call(`${commentId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    return String(body?.id || '') || null;
  }

  async like(commentId: string) {
    await this.call(`${commentId}/likes`, { method: 'POST' });
  }
}
