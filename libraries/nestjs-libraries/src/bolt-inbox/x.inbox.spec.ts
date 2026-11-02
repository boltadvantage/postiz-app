const calls: any[] = [];
const dmPages: any[] = [];
jest.mock('twitter-api-v2', () => ({
  TwitterApi: class {
    v2 = {
      userMentionTimeline: async (...a: any[]) => (calls.push(['mentions', ...a]), { data: { data: [], includes: {}, meta: {} } }),
      reply: async (...a: any[]) => (calls.push(['reply', ...a]), { data: { id: 'r1' } }),
      retweet: async (...a: any[]) => (calls.push(['retweet', ...a]), { data: {} }),
      like: async (...a: any[]) => (calls.push(['like', ...a]), { data: { liked: true } }),
      tweet: async (...a: any[]) => (calls.push(['tweet', ...a]), { data: { id: 'q1' } }),
      get: async (...a: any[]) => (calls.push(['get', ...a]), dmPages.shift() || { data: [], meta: {} }),
    };
  },
}));
import { XInbox, parseMentions } from './x.inbox';

describe('x inbox', () => {
  beforeEach(() => (calls.length = 0));

  it('turns a mentions page into mention / reply / quote items with authors and context', () => {
    const { items, resources, newestId } = parseMentions({
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
        tweets: [{ id: '900', text: 'my post', author_id: 'me' }],
      },
      meta: { newest_id: '3' },
    }, 'me');
    expect(items.map((i) => [i.id, i.kind, i.targetId])).toEqual([
      ['1', 'mention', null],
      ['2', 'reply', '900'],
      ['3', 'quote', '901'],
    ]);
    expect(items[1]).toMatchObject({ author: { id: 'u2', handle: 'critic' }, targetText: 'my post' });
    expect(items[2].targetText).toBeNull();
    expect(newestId).toBe('3');
    // mentions are your own data; the post they replied to is yours too; the people aren't
    expect(resources.posts).toEqual([
      { id: '1', own: true },
      { id: '2', own: true },
      { id: '3', own: true },
      { id: '900', own: true },
    ]);
    expect(resources.users).toEqual([
      { id: 'u1', own: false },
      { id: 'u2', own: false },
    ]);
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

  it('replies, reposts, quotes and likes through the right endpoints', async () => {
    const x = new XInbox('tok:sec');
    expect(await x.reply('900', 'thanks')).toBe('r1');
    await x.repost('me', '900');
    expect(await x.quote('900', 'worth a read')).toBe('q1');
    await x.like('me', '900');
    expect(calls).toEqual([
      ['reply', 'thanks', '900'],
      ['retweet', 'me', '900'],
      ['tweet', { text: 'worth a read', quote_tweet_id: '900' }],
      ['like', 'me', '900'],
    ]);
  });
});

describe('X direct messages', () => {
  const { parseDmEvents, xIdAfter, isDmPermissionError } = require('./x.inbox');
  const ME = '100';
  const page = {
    data: [
      { id: '1900', event_type: 'MessageCreate', text: 'thanks!', sender_id: ME, dm_conversation_id: '100-555', created_at: '2026-11-01T12:00:00Z' },
      { id: '1800', event_type: 'MessageCreate', text: 'love the post', sender_id: '555', dm_conversation_id: '100-555', created_at: '2026-11-01T11:00:00Z' },
      { id: '1700', event_type: 'MessageCreate', text: 'group hi', sender_id: '777', dm_conversation_id: '1234567890', created_at: '2026-11-01T10:00:00Z' },
      { id: '1600', event_type: 'ParticipantsJoin', sender_id: '777', dm_conversation_id: '7-100', created_at: '2026-11-01T09:00:00Z' },
    ],
    includes: { users: [{ id: '555', username: 'fan', name: 'Fan', profile_image_url: 'https://x/fan.png' }] },
    meta: { next_token: 'abc' },
  };

  it('keeps one-to-one messages both ways, skips groups and non-messages', () => {
    const r = parseDmEvents(page, ME);
    expect(r.messages.map((m: any) => [m.id, m.peer, m.direction])).toEqual([
      ['1900', '555', 'out'],
      ['1800', '555', 'in'],
    ]);
    expect(r.people.get('555')).toMatchObject({ handle: 'fan', name: 'Fan' });
    expect(r.reads).toBe(5);
    // every event returned is billed, group ones too
    expect(r.resources.dms).toEqual(page.data.map((e: any) => e.id));
    expect(r.nextToken).toBe('abc');
  });

  it('stops at what we already have', () => {
    const r = parseDmEvents(page, ME, '1800');
    expect(r.messages.map((m: any) => m.id)).toEqual(['1900']);
    expect(r.reachedKnown).toBe(true);
  });

  it('reports the newest event even when it is a group message', () => {
    expect(parseDmEvents({ data: [page.data[2], page.data[3]] }, ME).newestId).toBe('1700');
  });

  describe('since', () => {
    const { XDms } = require('./x.inbox');
    const dms = () => new XDms('a:b');
    const oldest = new Date('2026-10-01T00:00:00Z');
    beforeEach(() => ((calls.length = 0), (dmPages.length = 0)));

    it('peeks at one event when nothing is new, instead of re-reading a full page', async () => {
      dmPages.push({ data: [page.data[0]], includes: {}, meta: { next_token: 'n1' } });
      const r = await dms().since(ME, { afterId: '1900', budget: 20, oldest });
      expect(calls).toHaveLength(1);
      expect(calls[0][2].max_results).toBe(1);
      expect(r.messages).toEqual([]);
      expect(r.reads).toBe(1);
    });

    it('keeps reading past the peek in small pages when something new arrived', async () => {
      dmPages.push({ data: [page.data[0]], includes: {}, meta: { next_token: 'n1' } });
      dmPages.push({ data: [page.data[1], page.data[2]], includes: page.includes, meta: { next_token: 'n2' } });
      const r = await dms().since(ME, { afterId: '1700', budget: 20, oldest });
      expect(calls.map((c) => c[2].max_results)).toEqual([1, 5]);
      expect(r.resources.dms).toEqual(['1900', '1800', '1700']);
      expect(calls[1][2].pagination_token).toBe('n1');
      expect(r.messages.map((m: any) => m.id)).toEqual(['1900', '1800']);
      expect(r.newestId).toBe('1900');
    });

    it('reads a full page on the first run', async () => {
      dmPages.push({ data: page.data, includes: page.includes, meta: {} });
      await dms().since(ME, { budget: 20, oldest });
      expect(calls[0][2].max_results).toBe(20);
    });
  });

  it('compares ids too big for numbers', () => {
    expect(xIdAfter('1856000000000000001', '1856000000000000000')).toBe(true);
    expect(xIdAfter('1856000000000000000', '1856000000000000001')).toBe(false);
    expect(xIdAfter('5', null)).toBe(true);
  });

  it('recognizes a missing DM permission', () => {
    expect(isDmPermissionError({ code: 403 })).toBe(true);
    expect(isDmPermissionError({ code: 429 })).toBe(false);
  });
});
