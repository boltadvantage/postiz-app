import { generateSecretKey, getPublicKey, nip04, nip17, nip59 } from 'nostr-tools';
import { buildNip04, buildNip17, fromNip04, fromWrap } from './nostr.dm';

const me = generateSecretKey();
const ME = getPublicKey(me);
const fan = generateSecretKey();
const FAN = getPublicKey(fan);
const other = generateSecretKey();

describe('Nostr DMs', () => {
  it('reads an older-style (NIP-04) message to us', () => {
    const e = buildNip04(fan, ME, 'hi there');
    expect(fromNip04(e, ME, me)).toMatchObject({ peer: FAN, direction: 'in', text: 'hi there', protocol: 'nip04' });
  });

  it('reads our own NIP-04 message as sent, to the right person', () => {
    const e = buildNip04(me, FAN, 'thanks!');
    expect(fromNip04(e, ME, me)).toMatchObject({ peer: FAN, direction: 'out', text: 'thanks!' });
  });

  it("ignores NIP-04 messages between other people, and ones it can't decrypt", () => {
    expect(fromNip04(buildNip04(fan, getPublicKey(other), 'not for you'), ME, me)).toBeNull();
    const e = buildNip04(fan, ME, 'x');
    expect(fromNip04({ ...e, content: 'garbage?iv=abc' }, ME, me)).toBeNull();
  });

  it('reads a NIP-17 message another app sent us', () => {
    const wrap = nip17.wrapEvent(fan, { publicKey: ME }, 'private hello');
    expect(fromWrap(wrap, ME, me)).toMatchObject({ peer: FAN, direction: 'in', text: 'private hello', protocol: 'nip17' });
  });

  it('our NIP-17 send: both copies unwrap to the same message, and our copy knows who it went to', () => {
    const msg = buildNip17(me, FAN, 'see you there');
    const theirs = fromWrap(msg.toPeer, FAN, fan);
    const ours = fromWrap(msg.toSelf, ME, me);
    expect(theirs).toMatchObject({ peer: ME, direction: 'in', text: 'see you there', id: msg.id });
    expect(ours).toMatchObject({ peer: FAN, direction: 'out', text: 'see you there', id: msg.id });
    // the outer wraps don't reveal who's talking
    expect(msg.toPeer.pubkey).not.toBe(ME);
    expect(msg.toPeer.tags).toEqual([['p', FAN]]);
  });

  it('skips group chats and wraps meant for someone else', () => {
    const rumor = nip59.createRumor({ kind: 14, content: 'group', tags: [['p', ME], ['p', getPublicKey(other)]] }, fan);
    const group = nip59.createWrap(nip59.createSeal(rumor, fan, ME), ME);
    expect(fromWrap(group, ME, me)).toBeNull();
    expect(fromWrap(nip17.wrapEvent(fan, { publicKey: getPublicKey(other) }, 'x'), ME, me)).toBeNull();
  });

  it('NIP-04 content really is encrypted', () => {
    const e = buildNip04(me, FAN, 'secret');
    expect(e.content).not.toContain('secret');
    expect(nip04.decrypt(fan, ME, e.content)).toBe('secret');
  });
});

describe('Nostr DMs can not be forged', () => {
  const { finalizeEvent: sign, getEventHash, nip44 } = require('nostr-tools');
  const attacker = generateSecretKey();
  const vip = getPublicKey(generateSecretKey()); // someone the attacker wants to impersonate

  // a gift wrap built by hand so the parts can disagree
  const forge = (rumor: any, sealSigner: Uint8Array, sealPubkeyOverride?: string) => {
    let seal = sign({ kind: 13, created_at: rumor.created_at, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(sealSigner, ME)) }, sealSigner);
    if (sealPubkeyOverride) seal = { ...seal, pubkey: sealPubkeyOverride };
    const wrapKey = generateSecretKey();
    return sign({ kind: 1059, created_at: rumor.created_at, tags: [['p', ME]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(wrapKey, ME)) }, wrapKey);
  };
  const rumorFrom = (pubkey: string, content: string) => {
    const r: any = { kind: 14, pubkey, created_at: Math.floor(Date.now() / 1000), tags: [['p', ME]], content };
    r.id = getEventHash(r);
    return r;
  };

  it('rejects a message claiming to be from someone other than who sealed it', () => {
    expect(fromWrap(forge(rumorFrom(vip, 'wire the money'), attacker), ME, me)).toBeNull();
  });

  it('rejects a fake "you sent this" message', () => {
    expect(fromWrap(forge(rumorFrom(ME, 'I said something awful'), attacker), ME, me)).toBeNull();
  });

  it('rejects a seal with a swapped-in pubkey (bad signature)', () => {
    const r = rumorFrom(vip, 'hi');
    expect(fromWrap(forge(r, attacker, vip), ME, me)).toBeNull();
  });

  it('rejects a rumor whose id does not match its content', () => {
    const r = { ...rumorFrom(getPublicKey(attacker), 'original'), content: 'edited' };
    expect(fromWrap(forge(r, attacker), ME, me)).toBeNull();
  });

  it('still accepts a genuine message from the attacker as themselves', () => {
    const r = rumorFrom(getPublicKey(attacker), 'honest hello');
    expect(fromWrap(forge(r, attacker), ME, me)).toMatchObject({ peer: getPublicKey(attacker), direction: 'in', text: 'honest hello' });
  });
});
