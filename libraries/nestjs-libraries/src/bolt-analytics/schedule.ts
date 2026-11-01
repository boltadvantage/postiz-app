// Bolt Advantage: how often a post's numbers are refreshed. Nearly all engagement
// lands in the first days, so check daily for 30 days, weekly to 90, then stop.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const BACKFILL_DAYS = 90;
export const DAILY_UNTIL_DAYS = 30;
export const STOP_AFTER_DAYS = 90;

export function isDue(publishedAt: Date, lastSyncedAt: Date | null, now = new Date()) {
  const age = now.getTime() - publishedAt.getTime();
  if (age < 0) {
    return false;
  }
  if (!lastSyncedAt) {
    return true;
  }
  const since = now.getTime() - lastSyncedAt.getTime();
  if (age <= DAILY_UNTIL_DAYS * DAY) {
    // 20h, not 24h, so a run that drifts a little later still catches it
    return since >= 20 * HOUR;
  }
  if (age <= STOP_AFTER_DAYS * DAY) {
    return since >= 6.5 * DAY;
  }
  return false;
}

/** The newest posts matter most: they move the most and feed best-time picks. */
export function byPriority<T extends { publishedAt: Date }>(posts: T[]) {
  return [...posts].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

export function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
