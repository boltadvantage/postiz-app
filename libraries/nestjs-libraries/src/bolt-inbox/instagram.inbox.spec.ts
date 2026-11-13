import { InstagramInbox, parseComments, parseTags } from './instagram.inbox';

const ME = { id: '17841400000000001', username: 'boltadvantage' };
const media = {
  data: [
    {
      id: 'post1',
      caption: 'Town hall Friday',
      permalink: 'https://www.instagram.com/p/abc/',
      timestamp: '2026-11-12T12:00:00+0000',
      comments: {
        data: [
          {
            id: 'c1',
            text: 'What time?',
            timestamp: '2026-11-13T10:00:00+0000',
            from: { id: '901', username: 'al_fan' },
            replies: {
              data: [
                { id: 'r1', text: 'Noon', timestamp: '2026-11-13T10:05:00+0000', from: { id: ME.id, username: ME.username } },
                { id: 'r2', text: 'See you', timestamp: '2026-11-13T11:00:00+0000', username: 'bo' },
              ],
            },
          },
          { id: 'c0', text: 'old', timestamp: '2026-11-01T10:00:00+0000', from: { id: '903', username: 'cy' } },
        ],
      },
    },
  ],
};

describe('Instagram inbox', () => {
  it('keeps other people’s new comments and replies, threaded on the top comment', () => {
    const { items, newest } = parseComments(media, ME, new Date('2026-11-12T00:00:00Z'));
    expect(items.map((i) => [i.id, i.author.id, i.targetText, i.threadId])).toEqual([
      ['c1', 'al_fan', 'Town hall Friday', 'c1'],
      ['r2', 'bo', 'What time?', 'c1'],
    ]);
    expect(items[0].url).toBe('https://www.instagram.com/p/abc/');
    // our own reply still moves the cursor
    expect(newest.toISOString()).toBe('2026-11-13T11:00:00.000Z');
  });

  it('turns photo tags into mentions that can’t be replied to', () => {
    const { items } = parseTags({ data: [{ id: 'm9', username: 'rally_pics', caption: 'Great crowd @boltadvantage', permalink: 'https://www.instagram.com/p/xyz/', timestamp: '2026-11-13T09:00:00+0000' }] }, new Date('2026-11-12T00:00:00Z'));
    expect(items[0]).toMatchObject({ id: 'tag:m9', kind: 'mention', author: { id: 'rally_pics' }, threadId: null });
  });

  it('reads with the Page token and replies on the comment', async () => {
    const calls: any[] = [];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, json: async () => (url.includes('/media?') ? { data: [] } : { id: 'new1' }) };
    });
    const ig = new InstagramInbox(ME.id, 'pagetok___usertok');
    await ig.comments(new Date(), ME);
    expect(calls[0].url).toContain(`/${ME.id}/media?fields=`);
    expect(calls[0].url).toContain('access_token=pagetok');
    expect(await ig.reply('c1', 'Noon')).toBe('new1');
    expect(calls[1].url).toContain('/c1/replies?');
    expect(JSON.parse(calls[1].init.body)).toEqual({ message: 'Noon' });
  });
});
