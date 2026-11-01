const store = new Map<string, { v: string; exp: number }>();
let now = 0;
const live = (k: string) => {
  const e = store.get(k);
  if (e && e.exp <= now) store.delete(k);
  return store.get(k);
};
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: async (k: string, v: string, _ex: string, ttl: number) => (live(k) ? null : (store.set(k, { v, exp: now + ttl * 1000 }), 'OK')),
    get: async (k: string) => live(k)?.v ?? null,
    expire: async (k: string, ttl: number) => (live(k) ? ((store.get(k)!.exp = now + ttl * 1000), 1) : 0),
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  },
}));
import { isLocked, withLock } from './bolt.lock';

describe('sync lock', () => {
  beforeEach(() => {
    store.clear();
    now = 0;
  });

  it('runs, then releases', async () => {
    expect(await withLock('k', async () => 'done')).toBe('done');
    expect(await isLocked('k')).toBe(false);
  });

  it('a second run is skipped while the first holds it', async () => {
    let inner: unknown;
    await withLock('k', async () => {
      inner = await withLock('k', async () => 'second');
    });
    expect(inner).toBe(false);
  });

  it('releases even when the work fails', async () => {
    await expect(withLock('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await isLocked('k')).toBe(false);
  });

  it('a lock left by a process that died clears itself within the short expiry', async () => {
    store.set('k', { v: 'someone-who-crashed', exp: now + 120_000 });
    expect(await withLock('k', async () => 'blocked')).toBe(false);
    now += 121_000;
    expect(await withLock('k', async () => 'ran')).toBe('ran');
  });

  it("never deletes someone else's lock", async () => {
    await withLock('k', async () => {
      store.set('k', { v: 'other', exp: now + 120_000 }); // ours expired and someone else took it
    });
    expect(store.get('k')?.v).toBe('other');
  });
});
