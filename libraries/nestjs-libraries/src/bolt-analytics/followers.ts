// Bolt Advantage: each platform's TRUE follower total, read once a day. Growth is
// always total(later) - total(earlier); we never add up a platform's "new
// followers" metric (Facebook's in particular doesn't match the real count).
import type { Event } from 'nostr-tools';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import { NostrAnalytics } from '@gitroom/nestjs-libraries/bolt-analytics/nostr.analytics';
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
 * Nostr has no follower counter: a follower is anyone whose LATEST contact list
 * (kind 3) includes you. Lists are replaceable, so an older list naming you is
 * void once that person publishes a newer one without you.
 */
export function countNostrFollowers(latestLists: Event[], pubkey: string) {
  const latest = new Map<string, Event>();
  for (const e of latestLists) {
    if (e.kind !== 3 || e.pubkey === pubkey) {
      continue;
    }
    const prev = latest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at || (e.created_at === prev.created_at && e.id > prev.id)) {
      latest.set(e.pubkey, e);
    }
  }
  let count = 0;
  for (const e of latest.values()) {
    if (e.tags.some((t) => t[0] === 'p' && t[1] === pubkey)) {
      count += 1;
    }
  }
  return count;
}

export const NOSTR_MAX_CANDIDATES = 20000;
const AUTHOR_CHUNK = 300;

export async function nostrFollowers(pubkey: string): Promise<FollowerTotal> {
  const nostr = new NostrAnalytics();
  const relays = await nostr.relaysFor(pubkey);
  try {
    // relays cap each answer (often 500-5000 events), so page back through time
    const mentions: Event[] = [];
    const authors = new Set<string>();
    let until: number | undefined;
    for (let page = 0; page < 60 && authors.size < NOSTR_MAX_CANDIDATES; page++) {
      const batch = await nostr.querySync(relays, {
        kinds: [3],
        '#p': [pubkey],
        limit: 5000,
        ...(until ? { until } : {}),
      });
      const before = authors.size;
      for (const e of batch) {
        mentions.push(e);
        if (e.pubkey !== pubkey) authors.add(e.pubkey);
      }
      if (!batch.length || authors.size === before) {
        break;
      }
      until = Math.min(...batch.map((e) => e.created_at)) - 1;
    }
    const candidates = [...authors].slice(0, NOSTR_MAX_CANDIDATES);
    // re-read each candidate's own newest list: relays return any list naming you,
    // including old ones the person has since replaced
    const lists: Event[] = [...mentions];
    for (let i = 0; i < candidates.length; i += AUTHOR_CHUNK) {
      const authors = candidates.slice(i, i + AUTHOR_CHUNK);
      lists.push(...(await nostr.querySync(relays, { kinds: [3], authors, limit: authors.length * 2 })));
    }
    return { followers: countNostrFollowers(lists, pubkey), extra: { follower_candidates: candidates.length } };
  } finally {
    nostr.close(relays);
  }
}
