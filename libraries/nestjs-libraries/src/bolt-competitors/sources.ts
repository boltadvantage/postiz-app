// Bolt Advantage: reading a competitor's profile and recent posts on each
// platform. X costs money per item (charged by the caller); Instagram
// (business discovery, Business/Creator accounts only) and Nostr (Primal's
// index) are free. Facebook Pages and LinkedIn can't be read this way.
import { TwitterApi } from 'twitter-api-v2';
import { nip19 } from 'nostr-tools';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { pageToken, unreachable } from '@gitroom/nestjs-libraries/bolt-inbox/meta.dm';
import { PRIMAL_CACHE } from '@gitroom/nestjs-libraries/bolt-analytics/followers';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';

export const COMPETITOR_PLATFORMS = ['x', 'instagram', 'nostr'] as const;
export type CompetitorPlatform = (typeof COMPETITOR_PLATFORMS)[number];
export const POSTS_PER_CHECK = 10;

export type Profile = { externalId: string; name?: string; picture?: string; followers: number | null; posts: number | null };
export type SeenPost = { externalId: string; text: string; url?: string; publishedAt: Date; likes: number; reposts: number; replies: number };

/** "@Name", "x.com/Name", "instagram.com/name/" → the bare handle. */
export function cleanHandle(platform: CompetitorPlatform, raw: string) {
  const v = (raw || '').trim();
  if (platform === 'nostr') return v.replace(/^nostr:/, '');
  const fromUrl = /(?:x\.com|twitter\.com|instagram\.com)\/([^/?#]+)/i.exec(v);
  return (fromUrl ? fromUrl[1] : v).replace(/^@/, '').trim();
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- X ----------

export class XCompetitors {
  private client: TwitterApi;
  constructor(token: string) {
    const [accessToken, accessSecret] = token.split(':');
    this.client = new TwitterApi({ appKey: process.env.X_API_KEY!, appSecret: process.env.X_API_SECRET!, accessToken, accessSecret });
  }

  async profile(handle: string): Promise<Profile> {
    const r = await this.client.v2.userByUsername(handle, { 'user.fields': ['public_metrics', 'profile_image_url', 'name'] });
    if (!r.data) throw new Error(`No X account called @${handle}`);
    return {
      externalId: r.data.id,
      name: r.data.name,
      picture: r.data.profile_image_url,
      followers: num(r.data.public_metrics?.followers_count),
      posts: num(r.data.public_metrics?.tweet_count),
    };
  }

  /** Their newest original posts (no replies or reposts) after `sinceId`. */
  async posts(userId: string, handle: string, sinceId?: string): Promise<SeenPost[]> {
    const r: any = await this.client.v2.userTimeline(userId, {
      max_results: POSTS_PER_CHECK,
      exclude: ['retweets', 'replies'],
      'tweet.fields': ['created_at', 'public_metrics'],
      ...(sinceId ? { since_id: sinceId } : {}),
    });
    return (r?.data?.data || r?.tweets || []).map((t: any) => ({
      externalId: t.id,
      text: t.text || '',
      url: `https://x.com/${handle}/status/${t.id}`,
      publishedAt: new Date(t.created_at),
      likes: t.public_metrics?.like_count || 0,
      reposts: (t.public_metrics?.retweet_count || 0) + (t.public_metrics?.quote_count || 0),
      replies: t.public_metrics?.reply_count || 0,
    }));
  }
}

// ---------- Instagram ----------

/** Business discovery answer → profile and posts. */
export function parseDiscovery(body: any): { profile: Profile; posts: SeenPost[] } {
  const d = body?.business_discovery;
  if (!d) throw new Error('Instagram returned no account');
  return {
    profile: { externalId: String(d.id), name: d.name || d.username, picture: d.profile_picture_url, followers: num(d.followers_count), posts: num(d.media_count) },
    posts: (d.media?.data || []).map((m: any) => ({
      externalId: String(m.id),
      text: m.caption || '',
      url: m.permalink,
      publishedAt: new Date(m.timestamp),
      likes: m.like_count || 0,
      reposts: 0,
      replies: m.comments_count || 0,
    })),
  };
}

/** Reads another Business/Creator account through one of our Instagram channels. */
export async function instagramCompetitor(igUserId: string, token: string, handle: string) {
  const media = `media.limit(${POSTS_PER_CHECK}){id,caption,like_count,comments_count,timestamp,permalink}`;
  const fields = `business_discovery.username(${handle}){id,username,name,profile_picture_url,followers_count,media_count,${media}}`;
  const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${igUserId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(pageToken(token))}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw unreachable('Instagram', err);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    // a personal account, or a name that doesn't exist, comes back as "invalid user"
    throw new Error(/cannot be found|invalid user|not.*business/i.test(msg) ? `@${handle} isn't a public Business or Creator account on Instagram (Meta said: ${msg})` : `Instagram: ${msg}`);
  }
  return parseDiscovery(body);
}

// ---------- Nostr ----------

/** npub, nprofile, hex or name@domain (NIP-05) → hex public key. */
export async function nostrPubkey(handle: string) {
  const v = handle.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  if (/^(npub|nprofile)1/.test(v)) {
    const d = nip19.decode(v);
    return d.type === 'npub' ? (d.data as string) : (d.data as any).pubkey;
  }
  const m = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(v);
  if (!m) throw new Error('Use an npub or a name@domain address for Nostr');
  const url = `https://${m[2].toLowerCase()}/.well-known/nostr.json?name=${encodeURIComponent(m[1].toLowerCase())}`;
  if (!(await isSafePublicHttpsUrl(url))) throw new Error('That Nostr address can’t be looked up');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const pk = (await res.json().catch(() => ({})))?.names?.[m[1].toLowerCase()];
  if (!pk) throw new Error(`${v} doesn't point to a Nostr key`);
  return String(pk);
}

const PRIMAL_STATS = 10000105;
const PRIMAL_EVENT_STATS = 10000100;

async function primal(body: unknown) {
  let res: Response;
  try {
    res = await fetch(PRIMAL_CACHE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw unreachable('Primal (Nostr index)', err);
  }
  if (!res.ok) throw new Error(`Primal: HTTP ${res.status}`);
  const events = await res.json();
  return Array.isArray(events) ? events : [];
}

/** Primal's profile answer → profile. */
export function parsePrimalProfile(events: any[], pubkey: string): Profile {
  const meta = events.find((e) => e?.kind === 0);
  const stats = events.find((e) => e?.kind === PRIMAL_STATS);
  let p: any = {};
  let s: any = {};
  try {
    p = JSON.parse(meta?.content || '{}');
  } catch {
    p = {};
  }
  try {
    s = JSON.parse(stats?.content || '{}');
  } catch {
    s = {};
  }
  return { externalId: pubkey, name: p.display_name || p.name, picture: p.picture, followers: num(s.followers_count), posts: num(s.note_count) };
}

/** Primal's feed answer → notes with likes, reposts and replies. */
export function parsePrimalFeed(events: any[], pubkey: string): SeenPost[] {
  const stats = new Map<string, any>();
  for (const e of events) {
    if (e?.kind !== PRIMAL_EVENT_STATS) continue;
    try {
      const s = JSON.parse(e.content || '{}');
      if (s.event_id) stats.set(s.event_id, s);
    } catch {
      /* skip */
    }
  }
  return events
    .filter((e) => e?.kind === 1 && e.pubkey === pubkey)
    .slice(0, POSTS_PER_CHECK)
    .map((e) => {
      const s = stats.get(e.id) || {};
      return {
        externalId: e.id,
        text: e.content || '',
        url: `https://primal.net/e/${nip19.noteEncode(e.id)}`,
        publishedAt: new Date(e.created_at * 1000),
        likes: s.likes || 0,
        reposts: s.reposts || 0,
        replies: s.replies || 0,
      };
    });
}

export async function nostrCompetitor(handle: string) {
  const pubkey = await nostrPubkey(handle);
  const profile = parsePrimalProfile(await primal(['user_profile', { pubkey }]), pubkey);
  let posts: SeenPost[] = [];
  try {
    posts = parsePrimalFeed(await primal(['feed', { pubkey, notes: 'authored', limit: POSTS_PER_CHECK }]), pubkey);
  } catch {
    // follower counts still matter without posts
  }
  return { profile, posts };
}
