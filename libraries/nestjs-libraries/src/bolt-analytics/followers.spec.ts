jest.mock('@gitroom/nestjs-libraries/integrations/social/facebook.provider', () => ({ META_GRAPH_API_VERSION: 'v25.0' }));
jest.mock('nostr-tools', () => ({ SimplePool: class {} }));
import { countNostrFollowers, facebookFollowers, instagramFollowers, linkedinPageFollowers } from './followers';

const ME = 'me';
let n = 0;
const list = (pubkey: string, created_at: number, follows: string[]) =>
  ({ id: `id${n++}`, kind: 3, pubkey, created_at, content: '', sig: '', tags: follows.map((p) => ['p', p]) } as any);

describe('nostr follower count', () => {
  it('counts people whose latest list includes you', () => {
    expect(countNostrFollowers([list('a', 1, [ME]), list('b', 1, [ME, 'x']), list('c', 1, ['x'])], ME)).toBe(2);
  });

  it('latest list wins: a newer list without you is an unfollow', () => {
    expect(countNostrFollowers([list('a', 1, [ME]), list('a', 5, ['x'])], ME)).toBe(0);
    expect(countNostrFollowers([list('a', 5, [ME]), list('a', 1, ['x'])], ME)).toBe(1);
  });

  it('counts each person once across relays and ignores your own list', () => {
    const same = list('a', 3, [ME]);
    expect(countNostrFollowers([same, { ...same }, list(ME, 9, [ME])], ME)).toBe(1);
  });
});

describe('platform follower totals', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const reply = (body: any, ok = true) => {
    const calls: Array<[string, any]> = [];
    global.fetch = jest.fn(async (url: string, init?: any) => {
      calls.push([url, init]);
      return { ok, status: ok ? 200 : 400, json: async () => body } as any;
    }) as any;
    return calls;
  };

  it('Facebook uses followers_count, keeps Page likes separately', async () => {
    const calls = reply({ followers_count: 1234, fan_count: 1100 });
    expect(await facebookFollowers('PAGE', 'tok')).toEqual({ followers: 1234, extra: { page_likes: 1100 } });
    expect(calls[0][0]).toBe('https://graph.facebook.com/v25.0/PAGE?fields=followers_count,fan_count&access_token=tok');
  });

  it('Instagram uses the page part of a page___user token and the right host', async () => {
    const calls = reply({ followers_count: 900 });
    expect(await instagramFollowers('IG', 'page___user', 'graph.facebook.com')).toEqual({ followers: 900 });
    expect(calls[0][0]).toContain('https://graph.facebook.com/v25.0/IG?fields=followers_count&access_token=page');
    reply({ followers_count: 5 });
    expect(await instagramFollowers('IG', 'only', 'graph.instagram.com')).toEqual({ followers: 5 });
  });

  it('LinkedIn Page reads firstDegreeSize with versioned headers', async () => {
    const calls = reply({ firstDegreeSize: 321 });
    expect(await linkedinPageFollowers('42', 'tok')).toEqual({ followers: 321 });
    expect(calls[0][0]).toBe('https://api.linkedin.com/rest/networkSizes/urn%3Ali%3Aorganization%3A42?edgeType=COMPANY_FOLLOWED_BY_MEMBER');
    expect(calls[0][1].headers['LinkedIn-Version']).toBe('202601');
  });

  it('platform errors throw so the day is retried instead of storing a wrong number', async () => {
    reply({ error: { message: 'Invalid OAuth access token' } });
    await expect(facebookFollowers('PAGE', 'bad')).rejects.toThrow('Invalid OAuth access token');
    reply({}, false);
    await expect(linkedinPageFollowers('1', 'bad')).rejects.toThrow('HTTP 400');
  });
});
