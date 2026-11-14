import { FacebookInbox, parseFeed } from './facebook.inbox';

const PAGE = 'page1';
const feed = {
  data: [
    {
      id: 'page1_post1',
      message: 'Our town hall is Friday',
      permalink_url: 'https://www.facebook.com/page1/posts/1',
      comments: {
        data: [
          { id: 'post1_c3', message: 'See you there', created_time: '2026-11-03T12:00:00+0000', from: { id: 'u2', name: 'Bo' }, parent: { id: 'post1_c1' } },
          { id: 'post1_c2', message: 'Thanks!', created_time: '2026-11-03T11:00:00+0000', from: { id: PAGE, name: 'The Page' }, parent: { id: 'post1_c1' } },
          { id: 'post1_c1', message: 'What time?', created_time: '2026-11-03T10:00:00+0000', from: { id: 'u1', name: 'Al' }, permalink_url: 'https://www.facebook.com/c1' },
          { id: 'post1_old', message: 'old news', created_time: '2026-10-01T10:00:00+0000', from: { id: 'u3', name: 'Cy' } },
        ],
      },
    },
    { id: 'page1_post2', message: 'No comments yet' },
  ],
};

describe('Facebook inbox', () => {
  it('keeps other people’s new comments, oldest first, with what they answer', () => {
    const { items, newest } = parseFeed(feed, PAGE, new Date('2026-11-02T00:00:00Z'));
    expect(items.map((i) => i.id)).toEqual(['post1_c1', 'post1_c3']);
    expect(items[0]).toMatchObject({
      author: { id: 'u1', name: 'Al' },
      targetId: 'page1_post1',
      targetText: 'Our town hall is Friday',
      threadId: 'post1_c1',
      url: 'https://www.facebook.com/c1',
    });
    // a reply to a comment answers that comment, and is replied to on its thread
    expect(items[1]).toMatchObject({ targetId: 'post1_c1', targetText: 'What time?', threadId: 'post1_c1', url: 'https://www.facebook.com/page1/posts/1' });
    // the Page's own reply still moves the cursor forward
    expect(newest.toISOString()).toBe('2026-11-03T12:00:00.000Z');
  });

  it('keeps comments Facebook sends without an author, as an unnamed person', () => {
    const { items } = parseFeed(
      { data: [{ id: 'page1_p', message: 'Post', comments: { data: [{ id: 'p_c9', message: 'Hi', created_time: '2026-11-13T10:00:00+0000' }] } }] },
      PAGE,
      new Date('2026-11-12T00:00:00Z')
    );
    expect(items).toHaveLength(1);
    expect(items[0].author).toEqual({ id: 'anon:p_c9', name: 'Facebook user' });
  });

  it('keeps the cursor when nothing is new', () => {
    const since = new Date('2026-11-04T00:00:00Z');
    const { items, newest } = parseFeed(feed, PAGE, since);
    expect(items).toEqual([]);
    expect(newest).toEqual(since);
  });

  it('lists posts, reads comments only on posts with new activity, and replies and likes with the Page token', async () => {
    const calls: Array<{ url: string; init?: any }> = [];
    const list = {
      data: [
        { id: 'page1_post1', message: 'Our town hall is Friday', permalink_url: 'https://www.facebook.com/page1/posts/1', updated_time: '2026-11-03T12:00:00+0000' },
        { id: 'page1_quiet', message: 'Old', updated_time: '2026-10-20T12:00:00+0000' },
      ],
    };
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      const body = url.includes('/feed?') ? list : url.includes('/page1_post1/comments?filter') ? feed.data[0].comments : { id: 'new1', success: true };
      return { ok: true, status: 200, json: async () => body };
    });
    const fb = new FacebookInbox(PAGE, 'tok en');
    const { items } = await fb.comments(new Date('2026-11-02T00:00:00Z'));
    expect(items.map((i) => i.id)).toEqual(['post1_c1', 'post1_c3']);
    expect(calls[0].url).toContain(`/${PAGE}/feed?fields=`);
    expect(calls[0].url).toContain('access_token=tok%20en');
    // the quiet post isn't asked about
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/page1_post1/comments?filter=stream');
    expect(await fb.reply('post1_c1', 'Noon')).toBe('new1');
    expect(calls[2].url).toContain('/post1_c1/comments?access_token=');
    expect(JSON.parse(calls[2].init.body)).toEqual({ message: 'Noon' });
    await fb.like('post1_c1');
    expect(calls[3]).toMatchObject({ init: { method: 'POST' } });
    expect(calls[3].url).toContain('/post1_c1/likes?');
  });

  it('explains permission errors', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 200, message: 'Permissions error' } }) }));
    await expect(new FacebookInbox(PAGE, 't').comments(new Date())).rejects.toThrow('Reconnect this Page');
  });
});
