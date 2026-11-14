// Bolt Advantage: follows in the inbox — per-channel settings, the "notable
// followers only" filter, and turning what X and Nostr return into follows.
import type { Event } from 'nostr-tools';
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';

/** Follows are off until a channel turns them on. Empty filters = show everyone. */
export type FollowSetting = { on: boolean; verified: boolean; minFollowers: number };
export type FollowSettings = Record<string, FollowSetting>;
export const FOLLOW_PLATFORMS = ['x', 'nostr'];
export const OFF: FollowSetting = { on: false, verified: false, minFollowers: 0 };

const key = (organizationId: string) => `inbox-follows:${organizationId}`;
const clean = (v: any): FollowSetting => ({
  on: !!v?.on,
  verified: !!v?.verified,
  minFollowers: Math.max(0, Math.min(100_000_000, Math.floor(Number(v?.minFollowers) || 0))),
});

export async function followSettings(prisma: PrismaService, organizationId: string): Promise<FollowSettings> {
  const row = await prisma.boltSetting.findUnique({ where: { key: key(organizationId) } });
  try {
    const v = JSON.parse(row?.value || '{}');
    return Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).map(([id, s]) => [id, clean(s)]));
  } catch {
    return {};
  }
}

export async function saveFollowSetting(prisma: PrismaService, organizationId: string, integrationId: string, input: Partial<FollowSetting>) {
  const all = await followSettings(prisma, organizationId);
  all[integrationId] = clean({ ...(all[integrationId] || OFF), ...input });
  await prisma.boltSetting.upsert({
    where: { key: key(organizationId) },
    create: { key: key(organizationId), value: JSON.stringify(all) },
    update: { value: JSON.stringify(all) },
  });
  return all;
}

/** Does this follower pass the channel's filter? Every condition set must hold; with none set, everyone does. */
export function notable(s: FollowSetting, f: { verified: boolean; followers: number | null }) {
  if (s.verified && !f.verified) return false;
  if (s.minFollowers && (f.followers ?? 0) < s.minFollowers) return false;
  return true;
}

/** The same filter as a database condition, for one channel's rows. */
export function notableWhere(integrationId: string, s: FollowSetting) {
  return {
    integrationId,
    ...(s.verified ? { verified: true } : {}),
    ...(s.minFollowers ? { followers: { gte: s.minFollowers } } : {}),
  };
}

// ---------- X ----------

export type XFollower = { id: string; handle?: string; name?: string; avatar?: string; verified: boolean; followers: number | null };

/** One followers page (newest first) → followers. */
export function parseXFollowers(res: any): XFollower[] {
  return (res?.data || []).map((u: any) => ({
    id: String(u.id),
    handle: u.username,
    name: u.name,
    avatar: u.profile_image_url,
    // blue (Premium), business and government checks all count
    verified: !!u.verified || (!!u.verified_type && u.verified_type !== 'none'),
    followers: Number.isFinite(u.public_metrics?.followers_count) ? u.public_metrics.followers_count : null,
  }));
}

// ---------- Nostr ----------

/** Follow lists (kind 3) that name `self` → the newest list per author that does. */
export function nostrFollowersFrom(events: Event[], self: string) {
  const latest = new Map<string, Event>();
  for (const e of events) {
    if (e.kind !== 3 || e.pubkey === self) continue;
    const prev = latest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) latest.set(e.pubkey, e);
  }
  return [...latest.values()].filter((e) => followsSelf(e, self));
}

export const followsSelf = (e: Pick<Event, 'tags'>, self: string) => e.tags.some((t) => t[0] === 'p' && t[1] === self);

/** Newest list per author among `events` — for spotting who dropped `self`. */
export function newestLists(events: Event[]) {
  const latest = new Map<string, Event>();
  for (const e of events) {
    if (e.kind !== 3) continue;
    const prev = latest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) latest.set(e.pubkey, e);
  }
  return latest;
}

/** Your follow list with one more person on it (keeps everything else as it was). */
export function withFollow(list: Pick<Event, 'tags' | 'content'> | null, pubkey: string, relayHint = '') {
  const tags = (list?.tags || []).filter((t) => !(t[0] === 'p' && t[1] === pubkey));
  return { kind: 3, created_at: Math.floor(Date.now() / 1000), tags: [...tags, relayHint ? ['p', pubkey, relayHint] : ['p', pubkey]], content: list?.content || '' };
}

/** NIP-05: does name@domain point back at this key? Strangers choose the domain, so only public https. */
export async function verifyNip05(nip05: string | undefined, pubkey: string) {
  const m = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec((nip05 || '').trim());
  if (!m) return false;
  const [, name, domain] = m;
  const url = `https://${domain.toLowerCase()}/.well-known/nostr.json?name=${encodeURIComponent(name.toLowerCase())}`;
  try {
    if (!(await isSafePublicHttpsUrl(url))) return false;
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.names?.[name.toLowerCase()] === pubkey || body?.names?.[name] === pubkey;
  } catch {
    return false;
  }
}
