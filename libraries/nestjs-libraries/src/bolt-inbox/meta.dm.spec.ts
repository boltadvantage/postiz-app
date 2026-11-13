import { MetaDms, pageToken, parseConversations } from './meta.dm';

const PAGE = 'page1';
const convos = {
  data: [
    {
      id: 't1',
      updated_time: '2026-11-13T18:00:00+0000',
      participants: { data: [{ id: 'u1', name: 'Al Fan' }, { id: PAGE, name: 'The Page' }] },
      messages: {
        data: [
          { id: 'm3', message: 'Thanks!', from: { id: PAGE }, created_time: '2026-11-13T18:00:00+0000' },
          { id: 'm2', message: '', from: { id: 'u1' }, created_time: '2026-11-13T17:59:00+0000' },
          { id: 'm1', message: 'Old one', from: { id: 'u1' }, created_time: '2026-11-01T10:00:00+0000' },
        ],
      },
    },
    { id: 't2', updated_time: '2026-11-13T12:00:00+0000', participants: { data: [{ username: 'ig_fan', id: 'ig1' }, { id: PAGE }] }, messages: { data: [] } },
  ],
};

describe('Facebook and Instagram messages', () => {
  it('turns conversations into new messages with direction and the other person', () => {
    const r = parseConversations(convos, PAGE, new Date('2026-11-10T00:00:00Z'));
    expect(r.messages.map((m) => [m.id, m.peer, m.direction, m.text])).toEqual([
      ['m3', 'u1', 'out', 'Thanks!'],
      ['m2', 'u1', 'in', '[attachment]'],
    ]);
    expect(r.people.get('u1')).toEqual({ name: 'Al Fan', handle: undefined });
    expect(r.people.get('ig1')).toEqual({ name: 'ig_fan', handle: 'ig_fan' });
    expect(r.newest.toISOString()).toBe('2026-11-13T18:00:00.000Z');
  });

  it('uses the Page token, and explains the 24-hour window and missing permissions', async () => {
    expect(pageToken('pagetok___usertok')).toBe('pagetok');
    const calls: any[] = [];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ recipient_id: 'u1', message_id: 'mid.1' }) };
    });
    expect(await new MetaDms('instagram', 'pagetok___usertok').send('ig1', 'Hi')).toBe('mid.1');
    expect(calls[0].url).toContain('/me/messages?access_token=pagetok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ recipient: { id: 'ig1' }, message: { text: 'Hi' }, messaging_type: 'RESPONSE' });

    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 10, error_subcode: 2018278, message: 'outside of allowed window' } }) }));
    await expect(new MetaDms('facebook', 't').send('u1', 'Hi')).rejects.toThrow('within 24 hours');
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 200, message: 'Requires pages_messaging permission' } }) }));
    await expect(new MetaDms('facebook', 't').since(PAGE, new Date())).rejects.toThrow('pages_messaging');
  });
});

describe('unreachable', () => {
  it('says which service and why instead of "fetch failed"', async () => {
    const { unreachable } = await import('./meta.dm');
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
    expect(unreachable('Facebook', err).message).toBe("Couldn't reach Facebook (timed out). It'll try again on the next check.");
    (global as any).fetch = jest.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    const { MetaDms } = await import('./meta.dm');
    await expect(new MetaDms('instagram', 't').since('me', new Date())).rejects.toThrow("Couldn't reach Instagram (address lookup failed)");
  });
});
