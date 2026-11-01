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
