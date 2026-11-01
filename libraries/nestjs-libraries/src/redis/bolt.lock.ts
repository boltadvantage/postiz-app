// Bolt Advantage: a sync lock that can't outlive its process. The lock is
// short-lived and renewed while the work runs, so if Postiz restarts
// mid-sync the next check can go ahead within a couple of minutes (a long
// fixed expiry used to block every check, "Check now" included, for 30 min).
import { randomUUID } from 'crypto';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

export const LOCK_TTL_SECONDS = 120;

/** Run `fn` holding `key`; resolves to false (without running) if someone else holds it. */
export async function withLock<T>(key: string, fn: () => Promise<T>, ttlSeconds = LOCK_TTL_SECONDS): Promise<T | false> {
  const token = randomUUID();
  if (!(await ioRedis.set(key, token, 'EX', ttlSeconds, 'NX'))) return false;
  const renew = setInterval(async () => {
    try {
      if ((await ioRedis.get(key)) === token) await ioRedis.expire(key, ttlSeconds);
    } catch {
      /* next renewal will try again */
    }
  }, Math.max(1000, (ttlSeconds * 1000) / 3));
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    // only release our own lock
    if ((await ioRedis.get(key).catch(() => null)) === token) await ioRedis.del(key).catch(() => undefined);
  }
}

export const isLocked = (key: string) => ioRedis.get(key).then((v) => !!v);
