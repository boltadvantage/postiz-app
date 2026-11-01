// Bolt Advantage: each platform's TRUE follower total, read once a day. Growth is
// always total(later) - total(earlier); we never add up a platform's "new
// followers" metric (Facebook's in particular doesn't match the real count).
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import type { MetricMap } from '@gitroom/nestjs-libraries/bolt-analytics/metrics';

export type FollowerTotal = { followers: number | null; extra?: MetricMap };

const num = (v: unknown) => (v == null || !Number.isFinite(+v) ? null : Math.round(+v));

async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    throw new Error(body?.error?.message || body?.message || `HTTP ${res.status}`);
  }
  return body;
}

/** Facebook Page: followers_count is what the Page shows; fan_count is Page likes. */
export async function facebookFollowers(pageId: string, token: string): Promise<FollowerTotal> {
  const body = await getJson(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}?fields=followers_count,fan_count&access_token=${encodeURIComponent(token)}`
  );
  const likes = num(body.fan_count);
  return { followers: num(body.followers_count), extra: likes == null ? {} : { page_likes: likes } };
}

/** Instagram, both the Facebook-login and Instagram-login variants. Tokens may be `page___user`. */
export async function instagramFollowers(
  igUserId: string,
  token: string,
  host: 'graph.facebook.com' | 'graph.instagram.com'
): Promise<FollowerTotal> {
  const [accessToken] = token.split('___');
  const body = await getJson(
    `https://${host}/${META_GRAPH_API_VERSION}/${igUserId}?fields=followers_count&access_token=${encodeURIComponent(accessToken)}`
  );
  return { followers: num(body.followers_count) };
}

/** LinkedIn Page: members following the organization. */
export async function linkedinPageFollowers(orgId: string, token: string): Promise<FollowerTotal> {
  const urn = encodeURIComponent(`urn:li:organization:${orgId}`);
  const body = await getJson(`https://api.linkedin.com/rest/networkSizes/${urn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': '202601',
      'X-Restli-Protocol-Version': '2.0.0',
    },
  });
  return { followers: num(body.firstDegreeSize) };
}

// Personal LinkedIn profiles: no follower-count endpoint is available with the
// scopes this app has (it's restricted to approved partners), so we store null.

/**
 * Nostr has no follower counter, and relays each hold only a slice of everyone's
 * follow lists, so counting them gives a low number that changes with whichever
 * relays answer. Primal's indexer crawls the network and returns a stable total
 * (the number the Primal app shows), so growth reports compare like with like.
 * If Primal can't be reached the day is retried later rather than falling back
 * to a relay count, which would show up as a fake drop.
 */
export const PRIMAL_CACHE = 'https://cache2.primal.net/api';
const PRIMAL_USER_STATS_KIND = 10000105;

export async function nostrFollowers(pubkey: string): Promise<FollowerTotal> {
  const events = await getJson(PRIMAL_CACHE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(['user_profile', { pubkey }]),
    signal: AbortSignal.timeout(20000),
  });
  const stats = (Array.isArray(events) ? events : []).find((e: any) => e?.kind === PRIMAL_USER_STATS_KIND);
  let followers: number | null = null;
  try {
    followers = num(JSON.parse(stats?.content || '{}').followers_count);
  } catch {
    followers = null;
  }
  if (followers == null) {
    throw new Error('Primal returned no follower count');
  }
  return { followers };
}
