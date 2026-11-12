import { followSettings, newestLists, nostrFollowersFrom, notable, notableWhere, parseXFollowers, saveFollowSetting, verifyNip05, withFollow } from './follows';

const ME = 'a'.repeat(64);
const list = (pubkey: string, created_at: number, follows: string[]) =>
  ({ kind: 3, pubkey, created_at, tags: follows.map((p) => ['p', p]), content: '', id: `${pubkey}${created_at}`, sig: '' }) as any;

describe('follows', () => {
  it('shows everyone with no filter, and only notable followers with one', () => {
    const all = { on: true, verified: false, minFollowers: 0 };
    expect(notable(all, { verified: false, followers: 3 })).toBe(true);
    const picky = { on: true, verified: true, minFollowers: 1000 };
    expect(notable(picky, { verified: true, followers: 12 })).toBe(true);
    expect(notable(picky, { verified: false, followers: 1500 })).toBe(true);
    expect(notable(picky, { verified: false, followers: 999 })).toBe(false);
    expect(notable(picky, { verified: false, followers: null })).toBe(false);
    expect(notable({ on: true, verified: true, minFollowers: 0 }, { verified: false, followers: 1e6 })).toBe(false);
    expect(notableWhere('c1', picky)).toEqual({ integrationId: 'c1', OR: [{ verified: true }, { followers: { gte: 1000 } }] });
    expect(notableWhere('c1', all)).toEqual({ integrationId: 'c1' });
  });

  it('keeps each channel’s setting separately, off by default', async () => {
    const rows = new Map<string, string>();
    const prisma: any = {
      boltSetting: {
        findUnique: async ({ where }: any) => (rows.has(where.key) ? { value: rows.get(where.key) } : null),
        upsert: async ({ where, create }: any) => rows.set(where.key, create.value),
      },
    };
    expect(await followSettings(prisma, 'o')).toEqual({});
    await saveFollowSetting(prisma, 'o', 'burlison', { on: true, minFollowers: 1000.7 });
    await saveFollowSetting(prisma, 'o', 'burlison', { verified: true });
    await saveFollowSetting(prisma, 'o', 'mine', { minFollowers: -5 });
    expect(await followSettings(prisma, 'o')).toEqual({
      burlison: { on: true, verified: true, minFollowers: 1000 },
      mine: { on: false, verified: false, minFollowers: 0 },
    });
  });

  it('reads X followers with verification and follower counts', () => {
    const r = parseXFollowers({
      data: [
        { id: '1', username: 'gov', name: 'Gov', verified_type: 'government', public_metrics: { followers_count: 50000 } },
        { id: '2', username: 'fan', name: 'Fan', verified: false, verified_type: 'none', public_metrics: { followers_count: 12 } },
        { id: '3', username: 'new' },
      ],
    });
    expect(r.map((u) => [u.id, u.verified, u.followers])).toEqual([
      ['1', true, 50000],
      ['2', false, 12],
      ['3', false, null],
    ]);
  });

  it('finds Nostr followers from their newest follow list only', () => {
    const events = [
      list('b', 100, [ME]),
      list('b', 200, ['z']), // b dropped me since
      list('c', 150, ['z', ME]),
      list(ME, 300, ['b']), // my own list
      { ...list('d', 120, [ME]), kind: 1 },
    ];
    expect(nostrFollowersFrom(events, ME).map((e) => e.pubkey)).toEqual(['c']);
    expect(newestLists(events).get('b')!.created_at).toBe(200);
  });

  it('follows back by adding to the newest list without losing anyone', () => {
    const mine = list(ME, 300, ['b', 'c']);
    mine.content = '{"wss://relay":{}}';
    const next = withFollow(mine, 'd');
    expect(next.tags).toEqual([['p', 'b'], ['p', 'c'], ['p', 'd']]);
    expect(next.content).toBe(mine.content);
    expect(withFollow(mine, 'b').tags.filter((t) => t[1] === 'b')).toHaveLength(1);
  });

  it('checks NIP-05 addresses against the key, and only on public https', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ names: { jo: ME } }) }));
    expect(await verifyNip05('jo@example.com', ME)).toBe(true);
    expect(await verifyNip05('jo@example.com', 'b'.repeat(64))).toBe(false);
    expect(await verifyNip05('not an address', ME)).toBe(false);
    expect(await verifyNip05('jo@localhost', ME)).toBe(false);
  });
});
