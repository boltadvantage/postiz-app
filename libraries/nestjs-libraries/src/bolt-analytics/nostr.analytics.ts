// Bolt Advantage: Nostr engagement straight from relays (free, no API keys).
import { SimplePool } from 'nostr-tools';
import type { Event } from 'nostr-tools';
import WebSocket from 'ws';
import type { MetricMap } from '@gitroom/nestjs-libraries/bolt-analytics/metrics';

// @ts-ignore nostr-tools needs a global WebSocket in Node
global.WebSocket = global.WebSocket || WebSocket;

// Same relays Postiz publishes to, plus a few large public ones that index replies.
export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
];

const MAX_WAIT = 8000;
const CHUNK = 50;

export type NostrNote = { id: string; created_at: number; content: string };

/** Which of our note ids an engagement event points at (NIP-10 marked tags first). */
export function targetOf(event: Pick<Event, 'tags'>, ours: Set<string>) {
  const eTags = event.tags.filter((t) => t[0] === 'e' && ours.has(t[1]));
  if (eTags.length === 0) {
    return null;
  }
  return (eTags.find((t) => t[3] === 'reply') || eTags.find((t) => t[3] === 'root') || eTags[eTags.length - 1])[1];
}

/** Zap amount in sats: the zap request's `amount` tag (msats), else the bolt11 invoice. */
export function zapSats(event: Pick<Event, 'tags'>) {
  const description = event.tags.find((t) => t[0] === 'description')?.[1];
  if (description) {
    try {
      const amount = (JSON.parse(description).tags || []).find((t: string[]) => t[0] === 'amount')?.[1];
      if (amount && Number.isFinite(+amount)) {
        return Math.floor(+amount / 1000);
      }
    } catch {
      /* fall through to the invoice */
    }
  }
  const bolt11 = event.tags.find((t) => t[0] === 'bolt11')?.[1]?.toLowerCase();
  const m = bolt11?.match(/^ln(?:bc|tb|bcrt)(\d+)([munp]?)1/);
  if (!m) {
    return 0;
  }
  const btc = +m[1] * ({ '': 1, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 } as Record<string, number>)[m[2]];
  return Math.round(btc * 1e8);
}

/** Count engagement per note. Your own reactions/replies don't count. */
export function aggregate(ids: string[], events: Event[], selfPubkey: string) {
  const ours = new Set(ids);
  const out: Record<string, MetricMap> = {};
  for (const id of ids) {
    out[id] = { likes: 0, comments: 0, shares: 0, zaps: 0, zap_sats: 0 };
  }
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) {
      continue;
    }
    seen.add(e.id);
    const target = targetOf(e, ours);
    if (!target) {
      continue;
    }
    const m = out[target];
    if (e.kind === 9735) {
      m.zaps += 1;
      m.zap_sats += zapSats(e);
      continue;
    }
    if (e.pubkey === selfPubkey) {
      continue;
    }
    if (e.kind === 7 && e.content !== '-') {
      m.likes += 1;
    } else if (e.kind === 6 || e.kind === 16) {
      m.shares += 1;
    } else if (e.kind === 1) {
      m.comments += 1;
    }
  }
  return out;
}

export class NostrAnalytics {
  private pool = new SimplePool();

  /** Postiz's relays plus the write relays the user lists in their NIP-65 relay list. */
  async relaysFor(pubkey: string) {
    try {
      const list = await this.pool.get(DEFAULT_RELAYS, { kinds: [10002], authors: [pubkey] }, { maxWait: MAX_WAIT });
      const write = (list?.tags || [])
        .filter((t) => t[0] === 'r' && t[1]?.startsWith('wss://') && t[2] !== 'read')
        .map((t) => t[1].replace(/\/$/, ''));
      return [...new Set([...DEFAULT_RELAYS, ...write.slice(0, 6)])];
    } catch {
      return DEFAULT_RELAYS;
    }
  }

  /** Top-level notes (not replies) the user published since `since`. */
  async recentNotes(relays: string[], pubkey: string, since: Date): Promise<NostrNote[]> {
    const events = await this.pool.querySync(
      relays,
      { kinds: [1], authors: [pubkey], since: Math.floor(since.getTime() / 1000), limit: 1000 },
      { maxWait: MAX_WAIT }
    );
    const unique = new Map<string, Event>();
    for (const e of events) {
      if (!e.tags.some((t) => t[0] === 'e')) {
        unique.set(e.id, e);
      }
    }
    return [...unique.values()].map((e) => ({ id: e.id, created_at: e.created_at, content: e.content }));
  }

  async engagement(relays: string[], ids: string[], pubkey: string) {
    const events: Event[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      events.push(
        ...(await this.pool.querySync(relays, { kinds: [1, 6, 7, 16, 9735], '#e': chunk, limit: 5000 }, { maxWait: MAX_WAIT }))
      );
    }
    return aggregate(ids, events, pubkey);
  }

  close(relays: string[]) {
    try {
      this.pool.close(relays);
    } catch {
      /* already closed */
    }
  }
}
