import { facebookToUs, instagramToUs, replyToUs } from '@gitroom/nestjs-libraries/bolt-inbox/to-us';

describe('to us', () => {
  it('Facebook: a comment on our post is to us', () => {
    expect(facebookToUs({}, null, 'page')).toBe(true);
  });
  it('Facebook: replies in our thread, or tagging us, are to us; tagging someone else is not', () => {
    expect(facebookToUs({}, { from: { id: 'page' } }, 'page')).toBe(true);
    expect(facebookToUs({ message_tags: [{ id: 'page' }] }, { from: { id: 'u1' } }, 'page')).toBe(true);
    expect(facebookToUs({ message_tags: [{ id: 'u1' }] }, { from: { id: 'u1' } }, 'page')).toBe(false);
  });
  it('Facebook: no tags and someone else’s thread is settled later', () => {
    expect(facebookToUs({}, { from: { id: 'u1' } }, 'page')).toBeNull();
    expect(facebookToUs({}, {}, 'page')).toBeNull();
  });
  it('Instagram: by parent, then @handles', () => {
    const self = { id: 'ig', username: 'ericburlison' };
    expect(instagramToUs('hi', null, self)).toBe(true);
    expect(instagramToUs('hi', { username: 'ericburlison' }, self)).toBe(true);
    expect(instagramToUs('@EricBurlison thanks', { username: 'bob' }, self)).toBe(true);
    expect(instagramToUs('@bob you are wrong', { username: 'bob' }, self)).toBe(false);
    expect(instagramToUs('agreed', { username: 'bob' }, self)).toBeNull();
  });
  it('X / Nostr: mentions and quotes are to us; replies only when they answer us', () => {
    expect(replyToUs('mention', null, 'me')).toBe(true);
    expect(replyToUs('quote', 'other', 'me')).toBe(true);
    expect(replyToUs('reply', 'me', 'me')).toBe(true);
    expect(replyToUs('reply', 'other', 'me')).toBe(false);
    expect(replyToUs('reply', null, 'me')).toBeNull();
  });
});
