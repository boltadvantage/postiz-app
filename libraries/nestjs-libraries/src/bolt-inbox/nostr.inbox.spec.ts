import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, nip19 } from 'nostr-tools';
import { buildQuote, buildReply, buildRepost, classify, replyTarget, rootOf, secretKeyFromHex } from './nostr.inbox';

const ME = 'a'.repeat(64);
const FAN = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const ROOT = '1'.repeat(64);
const MID = '2'.repeat(64);
const ev = (tags: string[][], pubkey = FAN, kind = 1) =>
  ({ id: '9'.repeat(64), kind, pubkey, tags, content: 'hi', created_at: 1, sig: '' } as any);

describe('nostr inbox: classify', () => {
  it('sorts incoming notes into mention, reply and quote', () => {
    expect(classify(ev([['p', ME]]), ME)).toMatchObject({ kind: 'mention', targetId: null });
    expect(classify(ev([['e', ROOT, '', 'root'], ['e', MID, '', 'reply'], ['p', ME]]), ME)).toMatchObject({ kind: 'reply', targetId: MID });
    expect(classify(ev([['q', MID, '', ME], ['p', ME]]), ME)).toMatchObject({ kind: 'quote', targetId: MID });
  });

  it('ignores your own notes, other kinds, and notes that don’t tag you', () => {
    expect(classify(ev([['p', ME]], ME), ME)).toBeNull();
    expect(classify(ev([['p', ME]], FAN, 7), ME)).toBeNull();
    expect(classify(ev([['p', OTHER]]), ME)).toBeNull();
  });

  it('follows NIP-10 for the reply target and root, including old positional tags', () => {
    expect(replyTarget(ev([['e', ROOT]]))).toBe(ROOT);
    expect(replyTarget(ev([['e', ROOT], ['e', MID]]))).toBe(MID); // positional: last is the reply
    expect(replyTarget(ev([['e', ROOT, '', 'root']]))).toBe(ROOT);
    expect(rootOf(ev([['e', ROOT, '', 'root'], ['e', MID, '', 'reply']]))).toBe(ROOT);
  });
});

describe('nostr inbox: building events', () => {
  const relays = ['wss://relay.example'];

  it('reply to a top-level note marks it as root and tags its author', () => {
    const t = buildReply(ev([['p', ME]]), 'thanks!', ME, relays);
    expect(t.kind).toBe(1);
    expect(t.tags).toEqual([['e', '9'.repeat(64), 'wss://relay.example', 'root'], ['p', FAN]]);
  });

  it('reply inside a thread keeps the root, marks the reply, and tags everyone but you', () => {
    const target = ev([['e', ROOT, '', 'root'], ['e', MID, '', 'reply'], ['p', ME], ['p', OTHER]]);
    const t = buildReply(target, 'agreed', ME, relays);
    expect(t.tags).toEqual([
      ['e', ROOT, 'wss://relay.example', 'root'],
      ['e', '9'.repeat(64), 'wss://relay.example', 'reply'],
      ['p', FAN],
      ['p', OTHER],
    ]);
  });

  it('repost embeds the original event (NIP-18)', () => {
    const target = ev([['p', ME]]);
    const t = buildRepost(target, relays);
    expect(t.kind).toBe(6);
    expect(JSON.parse(t.content)).toEqual(target);
    expect(t.tags).toEqual([['e', target.id, 'wss://relay.example'], ['p', FAN]]);
  });

  it('quote links the note with nostr:nevent and a q tag', () => {
    const target = ev([['p', ME]]);
    const t = buildQuote(target, '  worth reading  ', relays);
    const link = t.content.split('nostr:')[1];
    const decoded = nip19.decode(link);
    expect(t.content.startsWith('worth reading\n\nnostr:nevent1')).toBe(true);
    expect(decoded.type).toBe('nevent');
    expect((decoded.data as any).id).toBe(target.id);
    expect(t.tags).toContainEqual(['q', target.id, 'wss://relay.example', FAN]);
  });

  it('signs valid events with a real key, and refuses a bad key', () => {
    const sk = generateSecretKey();
    const hex = Buffer.from(sk).toString('hex');
    const signed = finalizeEvent(buildReply(ev([['p', getPublicKey(sk)]]), 'hello', getPublicKey(sk), relays), secretKeyFromHex(hex));
    expect(verifyEvent(signed)).toBe(true);
    expect(() => secretKeyFromHex('nsec1notahexkey')).toThrow();
  });
});

describe('relay lists from Nostr events', () => {
  const { publicRelays } = require('./nostr.inbox');
  it('drops internal, loopback and non-wss addresses', async () => {
    const out = await publicRelays(
      ['wss://10.0.0.5:5432', 'wss://127.0.0.1', 'wss://192.168.1.10', 'wss://[::1]', 'wss://localhost', 'ws://1.1.1.1', 'https://1.1.1.1', 'wss://169.254.169.254', 'wss://1.1.1.1/'],
      8
    );
    expect(out).toEqual(['wss://1.1.1.1']);
  });
});
