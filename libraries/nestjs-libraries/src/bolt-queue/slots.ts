// Bolt Advantage: queue slot math. Slots are local times per weekday in the
// queue's timezone; this turns them into real instants, skipping taken ones.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/** source: picked from your history ('data'), a default to fill the day ('filler'), or set by you (absent). */
export type Slot = { day: number; minute: number; source?: 'data' | 'filler' };

export const MAX_SLOTS_PER_DAY = 24;

/** Keep valid, unique slots, sorted by day then time. */
export function normalizeSlots(input: unknown): Slot[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const out: Slot[] = [];
  for (const raw of input) {
    const day = Number((raw as any)?.day);
    const minute = Number((raw as any)?.minute);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (!Number.isInteger(minute) || minute < 0 || minute > 1439) continue;
    const key = `${day}:${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = (raw as any)?.source;
    out.push({ day, minute, ...(source === 'data' || source === 'filler' ? { source } : {}) });
  }
  out.sort((a, b) => a.day - b.day || a.minute - b.minute);
  const perDay = new Map<number, number>();
  return out.filter((s) => {
    const n = (perDay.get(s.day) || 0) + 1;
    perDay.set(s.day, n);
    return n <= MAX_SLOTS_PER_DAY;
  });
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minute-resolution key for comparing a post's time with a slot. */
export const minuteKey = (d: Date) => Math.floor(d.getTime() / 60000);

/**
 * The next `count` free slot instants after `from` (exclusive, with a one-minute
 * margin so a slot that's starting right now isn't handed out), within `horizonDays`.
 */
export function nextSlots(opts: {
  slots: Slot[];
  timeZone: string;
  from: Date;
  taken?: Set<number>;
  count: number;
  horizonDays?: number;
  /** local dates (YYYY-MM-DD) to skip entirely */
  daysOff?: Set<string>;
}): Date[] {
  const { slots, timeZone, from, count } = opts;
  const taken = opts.taken || new Set<number>();
  const horizon = opts.horizonDays ?? 90;
  if (!slots.length || count <= 0 || !isValidTimeZone(timeZone)) {
    return [];
  }
  const byDay = new Map<number, number[]>();
  for (const s of slots) {
    byDay.set(s.day, [...(byDay.get(s.day) || []), s.minute]);
  }
  const earliest = from.getTime() + 60000;
  const out: Date[] = [];
  const startLocal = dayjs(from).tz(timeZone).startOf('day');
  for (let i = 0; i <= horizon && out.length < count; i++) {
    const day = startLocal.add(i, 'day');
    const date = day.format('YYYY-MM-DD');
    if (opts.daysOff?.has(date)) continue;
    const minutes = (byDay.get(day.day()) || []).sort((a, b) => a - b);
    for (const m of minutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const at = dayjs.tz(`${date} ${hh}:${mm}`, timeZone).toDate();
      if (at.getTime() < earliest || taken.has(minuteKey(at))) {
        continue;
      }
      // a fall-back hour can map two slots to one instant; hand it out once
      if (out.length && out[out.length - 1].getTime() === at.getTime()) {
        continue;
      }
      out.push(at);
      if (out.length >= count) {
        break;
      }
    }
  }
  return out;
}

/** "Mon 9:00 AM" style label in the queue's timezone. */
export function slotLabel(minute: number) {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export const MAX_PER_DAY = 12;
// good general-purpose times to fill a day when history doesn't say enough
const FILLER_HOURS = [9, 12, 15, 18, 20, 10, 13, 16, 19, 8, 11, 14, 17, 21, 7, 22];

export type DayPick = Slot & { source: 'data' | 'filler'; posts?: number; avgEngagement?: number; lift?: number };

/**
 * Times to add to one weekday so it reaches `n` posts, given the times it
 * already has: highest-scoring hours with enough posts first, at least
 * `gapHours` from every other time, then default times if history doesn't say
 * enough. Never returns more than `n` minus what the day already has.
 */
export function fillDayTimes(
  day: number,
  cells: Array<{ hour: number; posts: number; score: number; avgEngagement?: number }>,
  existingMinutes: number[],
  n: number,
  overall: number,
  gapHours = 2,
  minPosts = 2
): DayPick[] {
  const want = Math.max(0, Math.min(MAX_PER_DAY, Math.floor(n)) - existingMinutes.length);
  const taken = [...existingMinutes];
  const chosen: DayPick[] = [];
  const fits = (h: number, gap: number) => taken.every((m) => Math.abs(m / 60 - h) >= gap);
  const take = (p: DayPick) => {
    chosen.push(p);
    taken.push(p.minute);
  };
  const ranked = cells
    .filter((c) => c.posts >= minPosts && c.score > overall)
    .sort((a, b) => b.score - a.score || b.posts - a.posts);
  for (const c of ranked) {
    if (chosen.length >= want) break;
    if (fits(c.hour, gapHours)) {
      take({
        day,
        minute: c.hour * 60,
        source: 'data',
        posts: c.posts,
        avgEngagement: c.avgEngagement,
        lift: overall ? Math.round((c.score / overall - 1) * 100) / 100 : 0,
      });
    }
  }
  // fill the rest; relax spacing only if the day is too full to keep it
  for (const gap of [gapHours, 1]) {
    for (const h of FILLER_HOURS) {
      if (chosen.length >= want) break;
      if (fits(h, gap)) take({ day, minute: h * 60, source: 'filler' });
    }
  }
  return chosen.sort((a, b) => a.minute - b.minute);
}

/** Best `n` times for one weekday from scratch (what "Pick best times" uses). */
export function pickDayTimes(
  day: number,
  cells: Array<{ hour: number; posts: number; score: number }>,
  n: number,
  overall: number,
  gapHours = 2,
  minPosts = 2
): Slot[] {
  return fillDayTimes(day, cells, [], n, overall, gapHours, minPosts).map(({ day: d, minute, source }) => ({ day: d, minute, source }));
}

export function normalizePerDay(input: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const d = Number(k);
      const n = Math.floor(Number(v));
      if (Number.isInteger(d) && d >= 0 && d <= 6 && Number.isFinite(n) && n >= 0) out[d] = Math.min(MAX_PER_DAY, n);
    }
  }
  return out;
}

export function normalizeDaysOff(input: unknown): string[] {
  const today = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const days = (Array.isArray(input) ? input : [])
    .map((d) => String(d))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && d >= today);
  return [...new Set(days)].sort().slice(0, 366);
}
