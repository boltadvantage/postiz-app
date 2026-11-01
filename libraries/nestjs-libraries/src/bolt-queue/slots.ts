// Bolt Advantage: queue slot math. Slots are local times per weekday in the
// queue's timezone; this turns them into real instants, skipping taken ones.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export type Slot = { day: number; minute: number };

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
    out.push({ day, minute });
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
