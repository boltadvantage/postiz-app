// Bolt Advantage: Nostr direct messages. Reads both kinds people use —
// NIP-04 (kind 4, older clients) and NIP-17 (gift-wrapped kind 14, current
// clients) — and answers in whichever one the conversation uses.
import { SimplePool, finalizeEvent, getEventHash, getPublicKey, nip04, nip44, nip59, verifyEvent } from 'nostr-tools';
import type { Event, EventTemplate } from 'nostr-tools';
import { DEFAULT_RELAYS } from '@gitroom/nestjs-libraries/bolt-analytics/nostr.analytics';
import { firstFulfilled, publicRelays, relayOverride, secretKeyFromHex } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.inbox';

const MAX_WAIT = 8000;
// NIP-59 wraps carry a random timestamp up to two days old, so look back further than the cursor
export const WRAP_SKEW_SECONDS = 2 * 24 * 60 * 60 + 3600;

export type DmProtocol = 'nip04' | 'nip17';

export type NostrDm = {
  /** event id (NIP-04) or rumor id (NIP-17); the same for both copies of a NIP-17 message */
  id: string;
  peer: string;
  direction: 'in' | 'out';
  text: string;
  at: number;
  protocol: DmProtocol;
};

const pTags = (tags: string[][]) => tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/i.test(t[1] || '')).map((t) => t[1]);

/** NIP-04 kind 4, either direction. Returns null for anything not between us and one other person. */
export function fromNip04(e: Event, self: string, sk: Uint8Array): NostrDm | null {
  if (e.kind !== 4) return null;
  const to = pTags(e.tags);
  let peer: string | undefined;
  let direction: NostrDm['direction'];
  if (e.pubkey === self) {
    peer = to.find((p) => p !== self);
    direction = 'out';
  } else if (to.includes(self)) {
    peer = e.pubkey;
    direction = 'in';
  } else {
    return null;
  }
  if (!peer) return null;
  try {
    return { id: e.id, peer, direction, text: nip04.decrypt(sk, peer, e.content), at: e.created_at, protocol: 'nip04' };
  } catch {
    return null;
  }
}

/**
 * Opens a NIP-59 gift wrap and returns the rumor only if it's authentic: the
 * seal must be a validly signed kind 13 by the same key the rumor claims as
 * its author, and the rumor's id must match its content. (nostr-tools'
 * unwrapEvent only decrypts, so anyone could forge a message "from" anyone,
 * including from you.)
 */
export function openWrap(wrap: Event, sk: Uint8Array) {
  try {
    const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey))) as Event;
    if (seal?.kind !== 13 || !verifyEvent(seal)) return null;
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey)));
    if (!rumor || typeof rumor.content !== 'string' || !Array.isArray(rumor.tags)) return null;
    if (rumor.pubkey !== seal.pubkey) return null;
    if (getEventHash(rumor) !== rumor.id) return null;
    return rumor as ReturnType<typeof nip59.unwrapEvent>;
  } catch {
    return null;
  }
}

/** NIP-17 gift wrap addressed to us. Group chats (more than one other person) are skipped. */
export function fromWrap(wrap: Event, self: string, sk: Uint8Array): NostrDm | null {
  if (wrap.kind !== 1059) return null;
  const rumor = openWrap(wrap, sk);
  if (!rumor || rumor.kind !== 14) return null;
  const others = [...new Set([rumor.pubkey, ...pTags(rumor.tags)])].filter((p) => p !== self);
  if (others.length !== 1) return null;
  return {
    id: rumor.id,
    peer: others[0],
    direction: rumor.pubkey === self ? 'out' : 'in',
    text: rumor.content,
    at: rumor.created_at,
    protocol: 'nip17',
  };
}

export function buildNip04(sk: Uint8Array, peer: string, text: string): Event {
  const template: EventTemplate = {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', peer]],
    content: nip04.encrypt(sk, peer, text),
  };
  return finalizeEvent(template, sk);
}

/**
 * One NIP-17 message as two gift wraps of the same rumor: one for them, one
 * for us (so our other apps see what we sent). Built by hand because
 * nostr-tools' self copy would only tag ourselves and lose who it was to.
 */
export function buildNip17(sk: Uint8Array, peer: string, text: string) {
  const rumor = nip59.createRumor({ kind: 14, content: text, tags: [['p', peer]] }, sk);
  const self = getPublicKey(sk);
  return {
    id: rumor.id,
    at: rumor.created_at,
    toPeer: nip59.createWrap(nip59.createSeal(rumor, sk, peer), peer),
    toSelf: nip59.createWrap(nip59.createSeal(rumor, sk, self), self),
  };
}

export class NostrDms {
  private pool = new SimplePool();

  /** NIP-17 inbox relays (kind 10050) for a person; empty when they haven't published any. */
  async dmRelays(pubkey: string): Promise<string[]> {
    const fixed = relayOverride();
    if (fixed) return fixed;
    try {
      const list = await this.pool.get(DEFAULT_RELAYS, { kinds: [10050], authors: [pubkey] }, { maxWait: MAX_WAIT });
      // anyone can publish this list (it's the other person's), so only public hosts
      return publicRelays((list?.tags || []).filter((t) => t[0] === 'relay').map((t) => t[1]), 6);
    } catch {
      return [];
    }
  }

  /** Every DM to or from us since `since` (NIP-04 both ways, NIP-17 wraps addressed to us). */
  async fetch(relays: string[], self: string, sk: Uint8Array, since: Date): Promise<NostrDm[]> {
    const s = Math.floor(since.getTime() / 1000);
    const [legacy, wraps] = await Promise.all([
      this.pool.querySync(relays, { kinds: [4], '#p': [self], since: s, limit: 500 }, { maxWait: MAX_WAIT }),
      this.pool.querySync(relays, { kinds: [1059], '#p': [self], since: s - WRAP_SKEW_SECONDS, limit: 500 }, { maxWait: MAX_WAIT }),
    ]);
    const sent = await this.pool.querySync(relays, { kinds: [4], authors: [self], since: s, limit: 500 }, { maxWait: MAX_WAIT });
    const out = new Map<string, NostrDm>();
    for (const e of [...legacy, ...sent]) {
      const m = fromNip04(e, self, sk);
      if (m) out.set(m.id, m);
    }
    for (const w of wraps) {
      const m = fromWrap(w, self, sk);
      if (m && m.at >= s - 300) out.set(m.id, m);
    }
    return [...out.values()].sort((a, b) => a.at - b.at);
  }

  /** Send in the conversation's protocol; resolves once a relay accepts the copy for them. */
  async send(opts: { relays: string[]; secretHex: string; peer: string; text: string; protocol: DmProtocol }) {
    const sk = secretKeyFromHex(opts.secretHex);
    const self = getPublicKey(sk);
    const peerRelays = await this.dmRelays(opts.peer);
    if (opts.protocol === 'nip04') {
      const e = buildNip04(sk, opts.peer, opts.text);
      await firstFulfilled(this.pool.publish([...new Set([...opts.relays, ...peerRelays])], e));
      return { id: e.id, at: e.created_at };
    }
    const msg = buildNip17(sk, opts.peer, opts.text);
    const mine = await this.dmRelays(self);
    await firstFulfilled(this.pool.publish(peerRelays.length ? peerRelays : opts.relays, msg.toPeer));
    // our own copy is a convenience; don't fail the send over it
    await firstFulfilled(this.pool.publish(mine.length ? mine : opts.relays, msg.toSelf)).catch(() => undefined);
    return { id: msg.id, at: msg.at };
  }

  close(relays: string[]) {
    try {
      this.pool.close(relays);
    } catch {
      /* already closed */
    }
  }
}
