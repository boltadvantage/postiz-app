// Bolt Advantage: per-account failed-attempt lockout. IP-based throttles can
// be dodged (proxies, spoofed headers, many addresses), so password and 2FA
// guesses are also counted per account: after `limit` failures within
// `windowSeconds` the account refuses further tries until the window ends.
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

const k = (key: string) => `bolt-attempts:${key}`;

/** Seconds until more tries are allowed; 0 when not locked. */
export async function lockedFor(key: string, limit: number): Promise<number> {
  const n = Number((await ioRedis.get(k(key))) || 0);
  if (n < limit) return 0;
  return Math.max(1, await ioRedis.ttl(k(key)));
}

export async function recordFailure(key: string, windowSeconds: number) {
  const n = await ioRedis.incr(k(key));
  if (n === 1) await ioRedis.expire(k(key), windowSeconds);
  return n;
}

export const clearFailures = (key: string) => ioRedis.del(k(key));

export const lockedMessage = (seconds: number) =>
  `Too many wrong attempts. Try again in ${Math.ceil(seconds / 60)} minute${seconds > 60 ? 's' : ''}.`;
