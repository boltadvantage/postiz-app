const calls: any[] = [];
jest.mock('twitter-api-v2', () => ({
  TwitterApi: class {
    v2 = {
      userMentionTimeline: async (...a: any[]) => (calls.push(['mentions', ...a]), { data: { data: [], includes: {}, meta: {} } }),
      reply: async (...a: any[]) => (calls.push(['reply', ...a]), { data: { id: 'r1' } }),
      retweet: async (...a: any[]) => (calls.push(['retweet', ...a]), { data: {} }),
      tweet: async (...a: any[]) => (calls.push(['tweet', ...a]), { data: { id: 'q1' } }),
    };
  },
}));
import { XInbox, parseMentions } from './x.inbox';

describe('x inbox', () => {
  beforeEach(() => (calls.length = 0));

  it('turns a mentions page into mention / reply / quote items with authors and context', () => {
    const { items, reads, newestId } = parseMentions({
      data: [
        { id: '1', author_id: 'u1', text: '@me hi', created_at: '2026-11-01T10:00:00Z' },
        { id: '2', author_id: 'u2', text: '@me nope', created_at: '2026-11-01T11:00:00Z', referenced_tweets: [{ type: 'replied_to', id: '900' }] },
        { id: '3', author_id: 'u1', text: 'look', created_at: '2026-11-01T12:00:00Z', referenced_tweets: [{ type: 'quoted', id: '901' }] },
      ],
      includes: {
        users: [
          { id: 'u1', username: 'fan', name: 'A Fan', profile_image_url: 'https://pbs/a.jpg' },
          { id: 'u2', username: 'critic', name: 'A Critic' },
        ],
        tweets: [{ id: '900', text: 'my post' }],
      },
      meta: { newest_id: '3' },
    });
    expect(items.map((i) => [i.id, i.kind, i.targetId])).toEqual([
      ['1', 'mention', null],
      ['2', 'reply', '900'],
      ['3', 'quote', '901'],
    ]);
    expect(items[1]).toMatchObject({ author: { id: 'u2', handle: 'critic' }, targetText: 'my post' });
    expect(items[2].targetText).toBeNull();
    expect(newestId).toBe('3');
    // 3 posts + 2 users (2 reads each) + 1 referenced post
    expect(reads).toBe(8);
  });

  it('only asks for new mentions after the first run, and limits the first run to recent days', async () => {
    const x = new XInbox('tok:sec');
    await x.mentions('me', { sinceId: '55', max: 40 });
    await x.mentions('me', { max: 500, firstRunDays: 7 });
    expect(calls[0][2]).toMatchObject({ since_id: '55', max_results: 40 });
    expect(calls[0][2].start_time).toBeUndefined();
    expect(calls[1][2].max_results).toBe(100);
    expect(Date.parse(calls[1][2].start_time)).toBeGreaterThan(Date.now() - 7.1 * 86400000);
  });

  it('replies, reposts and quotes through the right endpoints', async () => {
    const x = new XInbox('tok:sec');
    expect(await x.reply('900', 'thanks')).toBe('r1');
    await x.repost('me', '900');
    expect(await x.quote('900', 'worth a read')).toBe('q1');
    expect(calls).toEqual([
      ['reply', 'thanks', '900'],
      ['retweet', 'me', '900'],
      ['tweet', { text: 'worth a read', quote_tweet_id: '900' }],
    ]);
  });
});
