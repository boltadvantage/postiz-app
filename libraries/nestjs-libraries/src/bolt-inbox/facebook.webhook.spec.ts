import { createHmac } from 'crypto';
import { parseFeedPush, validSignature, verifyToken } from './facebook.webhook';
import { FacebookInbox } from './facebook.inbox';

describe('Facebook webhook', () => {
  it('checks Facebook’s signature', () => {
    const raw = Buffer.from('{"object":"page"}');
    const sig = 'sha256=' + createHmac('sha256', 'shh').update(raw).digest('hex');
    expect(validSignature(raw, sig, 'shh')).toBe(true);
    expect(validSignature(raw, sig, 'other')).toBe(false);
    expect(validSignature(raw, undefined, 'shh')).toBe(false);
    expect(validSignature(raw, 'sha256=abc', 'shh')).toBe(false);
  });

  it('picks the comments, with who wrote them, out of a push', () => {
    const push = {
      object: 'page',
      entry: [
        {
          id: '164',
          changes: [
            { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'p1_c1', post_id: '164_p1', from: { id: '999', name: 'Troll' }, message: 'x' } },
            { field: 'feed', value: { item: 'reaction', verb: 'add', post_id: '164_p1', from: { id: '5' } } },
            { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'p1_c2', post_id: '164_p1' } },
          ],
        },
      ],
    };
    expect(parseFeedPush(push)).toEqual([
      { pageId: '164', commentId: 'p1_c1', postId: '164_p1', verb: 'add', from: { id: '999', name: 'Troll' } },
      { pageId: '164', commentId: 'p1_c2', postId: '164_p1', verb: 'add', from: null },
    ]);
    expect(parseFeedPush({ object: 'instagram', entry: [] })).toEqual([]);
  });

  it('derives a verify token from the app secret unless one is set', () => {
    delete process.env.BOLT_META_WEBHOOK_TOKEN;
    process.env.FACEBOOK_APP_SECRET = 'shh';
    expect(verifyToken()).toHaveLength(24);
    process.env.BOLT_META_WEBHOOK_TOKEN = 'mine';
    expect(verifyToken()).toBe('mine');
  });

  it('bans by user id, falling back to an app-scoped id', async () => {
    const calls: any[] = [];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push(JSON.parse(init.body));
      const asUser = 'user' in JSON.parse(init.body);
      return asUser
        ? { ok: false, status: 400, json: async () => ({ error: { code: 100, message: 'Invalid user id' } }) }
        : { ok: true, status: 200, json: async () => ({ '999': true }) };
    });
    await new FacebookInbox('164', 't').ban('999');
    expect(calls).toEqual([{ user: ['999'] }, { asid: ['999'] }]);
  });
});
