jest.mock('nostr-tools', () => ({ SimplePool: class {} }));
import { aggregate, targetOf, zapSats } from './nostr.analytics';

const ME = 'me';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
let n = 0;
const ev = (kind: number, tags: string[][], pubkey = 'fan', content = '+') =>
  ({ id: `e${n++}`, kind, tags, pubkey, content, created_at: 0, sig: '' } as any);

describe('nostr analytics', () => {
  it('attributes a reply to the marked reply target, not the root', () => {
    expect(targetOf(ev(1, [['e', A, '', 'root'], ['e', B, '', 'reply']]), new Set([A, B]))).toBe(B);
    expect(targetOf(ev(1, [['e', A, '', 'root']]), new Set([A]))).toBe(A);
    expect(targetOf(ev(1, [['e', 'other']]), new Set([A]))).toBeNull();
  });

  it('reads zap amounts from the zap request, else the invoice', () => {
    const request = JSON.stringify({ tags: [['amount', '21000']] });
    expect(zapSats(ev(9735, [['description', request]]))).toBe(21);
    expect(zapSats(ev(9735, [['bolt11', 'lnbc210n1pjunk']]))).toBe(21);
    expect(zapSats(ev(9735, [['bolt11', 'lnbc10u1pjunk']]))).toBe(1000);
    expect(zapSats(ev(9735, [['bolt11', 'garbage']]))).toBe(0);
  });

  it('counts likes, replies, reposts and zaps; skips own activity, downvotes and duplicates', () => {
    const like = ev(7, [['e', A]]);
    const events = [
      like,
      like, // same event from a second relay
      ev(7, [['e', A]], 'fan', '-'), // downvote
      ev(7, [['e', A]], ME), // own like
      ev(1, [['e', A, '', 'reply']]),
      ev(1, [['e', A, '', 'reply']], ME), // own reply
      ev(6, [['e', A]]),
      ev(16, [['e', B]]),
      ev(9735, [['e', B], ['description', JSON.stringify({ tags: [['amount', '5000']] })]]),
    ];
    const out = aggregate([A, B], events, ME);
    expect(out[A]).toEqual({ likes: 1, comments: 1, shares: 1, zaps: 0, zap_sats: 0 });
    expect(out[B]).toEqual({ likes: 0, comments: 0, shares: 1, zaps: 1, zap_sats: 5 });
  });
});
