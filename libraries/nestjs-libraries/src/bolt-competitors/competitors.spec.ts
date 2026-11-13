import { growth } from './competitors.service';
import { cleanHandle, nostrPubkey, parseDiscovery, parsePrimalFeed, parsePrimalProfile } from './sources';

const PK = 'a'.repeat(64);

describe('competitors', () => {
  it('measures growth from the first to the latest saved count', () => {
    expect(growth([{ date: '2026-11-10', followers: 1100 }, { date: '2026-10-15', followers: 1000 }, { date: '2026-11-01', followers: null }])).toEqual({
      start: 1000,
      end: 1100,
      change: 100,
      percent: 10,
    });
    expect(growth([])).toEqual({ start: null, end: null, change: null, percent: null });
  });

  it('accepts handles the way people paste them', () => {
    expect(cleanHandle('x', '@RepBurlison')).toBe('RepBurlison');
    expect(cleanHandle('x', 'https://x.com/RepBurlison?s=20')).toBe('RepBurlison');
    expect(cleanHandle('instagram', 'https://www.instagram.com/some.page/')).toBe('some.page');
    expect(cleanHandle('nostr', 'nostr:npub1abc')).toBe('npub1abc');
  });

  it('reads Instagram business discovery', () => {
    const r = parseDiscovery({
      business_discovery: {
        id: '178',
        username: 'rival',
        name: 'Rival',
        followers_count: 5400,
        media_count: 310,
        media: { data: [{ id: 'm1', caption: 'Hello', like_count: 40, comments_count: 3, timestamp: '2026-11-12T10:00:00+0000', permalink: 'https://www.instagram.com/p/m1/' }] },
      },
    });
    expect(r.profile).toMatchObject({ externalId: '178', followers: 5400, posts: 310 });
    expect(r.posts[0]).toMatchObject({ externalId: 'm1', likes: 40, replies: 3, reposts: 0 });
    expect(() => parseDiscovery({})).toThrow('no account');
  });

  it('reads Primal profiles and notes with their stats', () => {
    const events = [
      { kind: 0, pubkey: PK, content: JSON.stringify({ display_name: 'Rival', picture: 'https://p/x.jpg' }) },
      { kind: 10000105, content: JSON.stringify({ followers_count: 812, note_count: 900 }) },
    ];
    expect(parsePrimalProfile(events, PK)).toMatchObject({ name: 'Rival', followers: 812, posts: 900 });
    const id = 'b'.repeat(64);
    const feed = parsePrimalFeed(
      [
        { kind: 1, id, pubkey: PK, content: 'gm', created_at: 1_700_000_000 },
        { kind: 1, id: 'c'.repeat(64), pubkey: 'other', content: 'not theirs', created_at: 1_700_000_000 },
        { kind: 10000100, content: JSON.stringify({ event_id: id, likes: 9, replies: 2, reposts: 1 }) },
      ],
      PK
    );
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ likes: 9, replies: 2, reposts: 1 });
    expect(feed[0].url).toMatch(/^https:\/\/primal\.net\/e\/note1/);
  });

  it('turns hex keys and npubs into the key, and refuses junk', async () => {
    expect(await nostrPubkey(PK.toUpperCase())).toBe(PK);
    const { nip19 } = await import('nostr-tools');
    expect(await nostrPubkey(nip19.npubEncode(PK))).toBe(PK);
    await expect(nostrPubkey('not a key')).rejects.toThrow('npub');
  });
});
