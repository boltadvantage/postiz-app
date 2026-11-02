// Bolt Advantage: Nostr inbox — mentions, replies and quotes from relays, and
// replying, reposting, quoting and liking with the channel's key.
import { SimplePool, finalizeEvent, nip19 } from 'nostr-tools';
import type { Event, EventTemplate } from 'nostr-tools';
import WebSocket from 'ws';
import { DEFAULT_RELAYS } from '@gitroom/nestjs-libraries/bolt-analytics/nostr.analytics';

// @ts-ignore nostr-tools needs a global WebSocket in Node
global.WebSocket = global.WebSocket || WebSocket;

const MAX_WAIT = 8000;

export type InboxKind = 'mention' | 'reply' | 'quote';

export type IncomingNostr = {
  event: Event;
  kind: InboxKind;
  /** our note it answers or quotes, when it points at one */
  targetId: string | null;
};

export type NostrProfile = { name?: string; avatar?: string; handle?: string };

/** BOLT_NOSTR_RELAYS replaces every relay list (used for tests against a private relay). */
export function relayOverride(): string[] | null {
  const v = (process.env.BOLT_NOSTR_RELAYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return v.length ? v : null;
}

/** NIP-10: the event this one replies to (marked "reply", else "root", else the last e tag). */
export function replyTarget(e: Pick<Event, 'tags'>): string | null {
  const eTags = e.tags.filter((t) => t[0] === 'e' && t[1]);
  if (!eTags.length) return null;
  return (eTags.find((t) => t[3] === 'reply') || (eTags.length === 1 ? eTags[0] : null) || eTags.find((t) => t[3] === 'root') || eTags[eTags.length - 1])[1];
}

/** NIP-10 root of the thread this event belongs to. */
export function rootOf(e: Pick<Event, 'id' | 'tags'>): string {
  return e.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1] || e.tags.find((t) => t[0] === 'e')?.[1] || e.id;
}

export function classify(e: Event, self: string): IncomingNostr | null {
  if (e.kind !== 1 || e.pubkey === self || !e.tags.some((t) => t[0] === 'p' && t[1] === self)) {
    return null;
  }
  const quoted = e.tags.find((t) => t[0] === 'q' && t[1]);
  if (quoted) {
    return { event: e, kind: 'quote', targetId: quoted[1] };
  }
  const target = replyTarget(e);
  if (target) {
    return { event: e, kind: 'reply', targetId: target };
  }
  return { event: e, kind: 'mention', targetId: null };
}

export function parseProfile(e: Event | undefined): NostrProfile {
  if (!e) return {};
  try {
    const c = JSON.parse(e.content || '{}');
    return {
      name: c.display_name || c.displayName || c.name || undefined,
      avatar: c.picture || undefined,
      handle: c.nip05 || c.name || undefined,
    };
  } catch {
    return {};
  }
}

const relayHint = (relays: string[]) => relays[0] || '';

/** Reply that threads correctly in every client: root + reply markers, everyone in the thread tagged. */
export function buildReply(target: Event, text: string, self: string, relays: string[]): EventTemplate {
  const root = target.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1];
  const hint = relayHint(relays);
  const eTags = root && root !== target.id
    ? [['e', root, hint, 'root'], ['e', target.id, hint, 'reply']]
    : [['e', target.id, hint, 'root']];
  const people = [target.pubkey, ...target.tags.filter((t) => t[0] === 'p').map((t) => t[1])].filter((p, i, a) => p && p !== self && a.indexOf(p) === i);
  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: text,
    tags: [...eTags, ...people.map((p) => ['p', p])],
  };
}

/** NIP-18 repost: kind 6 with the original event embedded. */
export function buildRepost(target: Event, relays: string[]): EventTemplate {
  return {
    kind: 6,
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify(target),
    tags: [['e', target.id, relayHint(relays)], ['p', target.pubkey]],
  };
}

/** NIP-25 like: a "+" reaction pointing at the note and its author. */
export function buildLike(target: Event, relays: string[]): EventTemplate {
  return {
    kind: 7,
    created_at: Math.floor(Date.now() / 1000),
    content: '+',
    tags: [['e', target.id, relayHint(relays), target.pubkey], ['p', target.pubkey], ['k', String(target.kind)]],
  };
}

/** NIP-18 quote: your text, a nostr: link clients render as the embedded note, and a q tag. */
export function buildQuote(target: Event, text: string, relays: string[]): EventTemplate {
  const nevent = nip19.neventEncode({ id: target.id, author: target.pubkey, relays: relays.slice(0, 2) });
  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: `${text.trim()}\n\nnostr:${nevent}`,
    tags: [['q', target.id, relayHint(relays), target.pubkey], ['p', target.pubkey]],
  };
}

export function secretKeyFromHex(hex: string) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('This Nostr channel has no usable key; reconnect it');
  }
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/** Resolves with the first promise that succeeds; rejects only if all fail. */
export function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let failed = 0;
    if (!promises.length) return reject(new Error('No relays to publish to'));
    for (const p of promises) {
      p.then(resolve, (err) => {
        failed += 1;
        if (failed === promises.length) reject(new Error(`No relay accepted the note (${err?.message || err})`));
      });
    }
  });
}

export class NostrInbox {
  private pool = new SimplePool();

  /** Where people send you things (NIP-65 read relays) plus the usual relays. */
  async relays(pubkey: string) {
    const fixed = relayOverride();
    if (fixed) return fixed;
    try {
      const list = await this.pool.get(DEFAULT_RELAYS, { kinds: [10002], authors: [pubkey] }, { maxWait: MAX_WAIT });
      const mine = (list?.tags || [])
        .filter((t) => t[0] === 'r' && t[1]?.startsWith('wss://'))
        .map((t) => t[1].replace(/\/$/, ''));
      return [...new Set([...DEFAULT_RELAYS, ...mine.slice(0, 8)])];
    } catch {
      return DEFAULT_RELAYS;
    }
  }

  async incoming(relays: string[], pubkey: string, since: Date, limit = 500): Promise<IncomingNostr[]> {
    const events = await this.pool.querySync(
      relays,
      { kinds: [1], '#p': [pubkey], since: Math.floor(since.getTime() / 1000), limit },
      { maxWait: MAX_WAIT }
    );
    const seen = new Set<string>();
    const out: IncomingNostr[] = [];
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const c = classify(e, pubkey);
      if (c) out.push(c);
    }
    return out.sort((a, b) => a.event.created_at - b.event.created_at);
  }

  async profiles(relays: string[], pubkeys: string[]) {
    const out = new Map<string, NostrProfile>();
    for (let i = 0; i < pubkeys.length; i += 200) {
      const events = await this.pool.querySync(relays, { kinds: [0], authors: pubkeys.slice(i, i + 200) }, { maxWait: MAX_WAIT });
      const latest = new Map<string, Event>();
      for (const e of events) {
        const prev = latest.get(e.pubkey);
        if (!prev || e.created_at > prev.created_at) latest.set(e.pubkey, e);
      }
      for (const [pk, e] of latest) out.set(pk, parseProfile(e));
    }
    return out;
  }

  async events(relays: string[], ids: string[]) {
    if (!ids.length) return new Map<string, Event>();
    const events = await this.pool.querySync(relays, { ids }, { maxWait: MAX_WAIT });
    return new Map(events.map((e) => [e.id, e]));
  }

  /** Sign and send; resolves once at least one relay accepts it. */
  async publish(relays: string[], template: EventTemplate, secretHex: string) {
    const signed = finalizeEvent(template, secretKeyFromHex(secretHex));
    await firstFulfilled(this.pool.publish(relays, signed));
    return signed;
  }

  close(relays: string[]) {
    try {
      this.pool.close(relays);
    } catch {
      /* already closed */
    }
  }
}
