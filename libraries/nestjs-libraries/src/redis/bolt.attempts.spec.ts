const store = new Map<string, { n: number; ttl: number }>();
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    get: async (k: string) => (store.has(k) ? String(store.get(k)!.n) : null),
    incr: async (k: string) => {
      const e = store.get(k) || { n: 0, ttl: -1 };
      e.n += 1;
      store.set(k, e);
      return e.n;
    },
    expire: async (k: string, s: number) => ((store.get(k)!.ttl = s), 1),
    ttl: async (k: string) => store.get(k)?.ttl ?? -2,
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  },
}));
import { clearFailures, lockedFor, lockedMessage, recordFailure } from './bolt.attempts';
import { realClientIp } from '../throttler/throttler.provider';
import { isOrgAdmin, requireOrgAdmin } from '../user/require.org.admin';

describe('per-account lockout', () => {
  beforeEach(() => store.clear());

  it('locks after the limit, for the rest of the window', async () => {
    for (let i = 0; i < 4; i++) await recordFailure('2fa:u1', 900);
    expect(await lockedFor('2fa:u1', 5)).toBe(0);
    await recordFailure('2fa:u1', 900);
    expect(await lockedFor('2fa:u1', 5)).toBe(900);
    expect(lockedMessage(900)).toBe('Too many wrong attempts. Try again in 15 minutes.');
  });

  it('a success clears it; other accounts are unaffected', async () => {
    for (let i = 0; i < 5; i++) await recordFailure('login:a@x', 900);
    expect(await lockedFor('login:b@x', 5)).toBe(0);
    await clearFailures('login:a@x');
    expect(await lockedFor('login:a@x', 5)).toBe(0);
  });
});

describe('real visitor address', () => {
  it("uses Cloudflare's header over a spoofable X-Forwarded-For", () => {
    expect(realClientIp({ headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } })).toBe('203.0.113.9');
  });
  it('falls back to X-Forwarded-For, then the socket address', () => {
    expect(realClientIp({ headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.2' } })).toBe('198.51.100.1');
    expect(realClientIp({ headers: {}, ip: '10.0.0.5' })).toBe('10.0.0.5');
  });
});

describe('admin-only controls', () => {
  it('lets admins through and stops members', () => {
    expect(isOrgAdmin({ users: [{ role: 'ADMIN' }] })).toBe(true);
    expect(isOrgAdmin({ users: [{ role: 'SUPERADMIN' }] })).toBe(true);
    expect(() => requireOrgAdmin({ users: [{ role: 'USER' }] })).toThrow('Only an admin');
    expect(() => requireOrgAdmin({})).toThrow();
  });
});
