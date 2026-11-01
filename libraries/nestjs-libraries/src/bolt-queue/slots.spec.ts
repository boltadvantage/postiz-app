import { minuteKey, nextSlots, normalizeSlots, slotLabel } from './slots';

const TZ = 'America/Chicago';
const iso = (d: Date[]) => d.map((x) => x.toISOString());

describe('queue slots', () => {
  it('cleans input: range, duplicates, order, per-day cap', () => {
    expect(
      normalizeSlots([
        { day: 1, minute: 540 },
        { day: 1, minute: 540 },
        { day: 0, minute: 600 },
        { day: 7, minute: 10 },
        { day: 2, minute: 1440 },
        { day: '3', minute: '60' },
        null,
      ])
    ).toEqual([
      { day: 0, minute: 600 },
      { day: 1, minute: 540 },
      { day: 3, minute: 60 },
    ]);
    expect(normalizeSlots(Array.from({ length: 40 }, (_, i) => ({ day: 1, minute: i * 10 })))).toHaveLength(24);
    expect(normalizeSlots('nope')).toEqual([]);
  });

  it('uses each weekday’s own times in local time', () => {
    // Sun 2026-11-01 08:00 CST (14:00Z). Mon 9:00 and Wed 13:30 slots.
    const from = new Date('2026-11-01T14:00:00Z');
    const out = nextSlots({ slots: [{ day: 1, minute: 540 }, { day: 3, minute: 810 }], timeZone: TZ, from, count: 3 });
    expect(iso(out)).toEqual(['2026-11-02T15:00:00.000Z', '2026-11-04T19:30:00.000Z', '2026-11-09T15:00:00.000Z']);
  });

  it('keeps 9:00 local across daylight saving (no UTC drift)', () => {
    // Saturday before DST ends (CDT, UTC-5) then Monday after (CST, UTC-6)
    const from = new Date('2026-10-31T12:00:00Z');
    const out = nextSlots({ slots: [{ day: 6, minute: 540 }, { day: 1, minute: 540 }], timeZone: TZ, from, count: 2 });
    expect(iso(out)).toEqual(['2026-10-31T14:00:00.000Z', '2026-11-02T15:00:00.000Z']);
  });

  it('skips slots that are taken, in the past, or starting right now', () => {
    const slots = [{ day: 1, minute: 540 }, { day: 1, minute: 600 }, { day: 1, minute: 660 }];
    const from = new Date('2026-11-02T15:00:30Z'); // Mon 9:00:30 local
    const taken = new Set([minuteKey(new Date('2026-11-02T16:00:00Z'))]); // 10:00 taken
    const out = nextSlots({ slots, timeZone: TZ, from, taken, count: 2 });
    expect(iso(out)).toEqual(['2026-11-02T17:00:00.000Z', '2026-11-09T15:00:00.000Z']);
  });

  it('returns nothing for no slots or a bad timezone, and respects the horizon', () => {
    const from = new Date('2026-11-01T14:00:00Z');
    expect(nextSlots({ slots: [], timeZone: TZ, from, count: 3 })).toEqual([]);
    expect(nextSlots({ slots: [{ day: 1, minute: 540 }], timeZone: 'Mars/Base', from, count: 3 })).toEqual([]);
    expect(nextSlots({ slots: [{ day: 1, minute: 540 }], timeZone: TZ, from, count: 10, horizonDays: 14 })).toHaveLength(2);
  });

  it('handles the spring-forward gap without losing the slot', () => {
    // 2026-03-08 is a Sunday; 2:30 AM doesn't exist in Chicago that night
    const out = nextSlots({ slots: [{ day: 0, minute: 150 }], timeZone: TZ, from: new Date('2026-03-07T12:00:00Z'), count: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].toISOString()).toBe('2026-03-08T08:30:00.000Z'); // 3:30 CDT
  });

  it('labels slots', () => {
    expect(slotLabel(0)).toBe('12:00 AM');
    expect(slotLabel(540)).toBe('9:00 AM');
    expect(slotLabel(810)).toBe('1:30 PM');
  });
});

import { normalizeDaysOff, normalizePerDay, pickDayTimes } from './slots';

describe('queue v2', () => {
  it('skips days off but keeps the rest of the week', () => {
    // Christmas 2026 is a Friday
    const out = nextSlots({
      slots: [{ day: 4, minute: 540 }, { day: 5, minute: 540 }, { day: 6, minute: 540 }],
      timeZone: TZ,
      from: new Date('2026-12-23T12:00:00Z'),
      count: 3,
      daysOff: new Set(['2026-12-25']),
    });
    expect(out.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-12-24', '2026-12-26', '2026-12-31']);
  });

  it('picks the best n hours, spaced apart, and fills with defaults when history is thin', () => {
    const cells = [
      { hour: 9, posts: 6, score: 40 },
      { hour: 10, posts: 5, score: 38 }, // too close to 9
      { hour: 13, posts: 4, score: 30 },
      { hour: 20, posts: 1, score: 90 }, // one post: not enough
      { hour: 7, posts: 5, score: 5 }, // below average
    ];
    const three = pickDayTimes(1, cells, 3, 20);
    expect(three).toEqual([
      { day: 1, minute: 540, source: 'data' },
      { day: 1, minute: 780, source: 'data' },
      { day: 1, minute: 900, source: 'filler' }, // 15:00, first filler 2h+ from both
    ]);
    expect(pickDayTimes(1, cells, 0, 20)).toEqual([]);
    expect(pickDayTimes(1, [], 2, 20).every((s) => s.source === 'filler')).toBe(true);
  });

  it('can fit a busy day by relaxing the spacing, capped at 12', () => {
    const busy = pickDayTimes(2, [], 12, 0);
    expect(busy).toHaveLength(12);
    expect(new Set(busy.map((s) => s.minute)).size).toBe(12);
    expect(pickDayTimes(2, [], 50, 0)).toHaveLength(12);
  });

  it('cleans per-day counts and days off', () => {
    expect(normalizePerDay({ 1: 3, 2: '1', 7: 4, 3: -1, 4: 99, x: 2 })).toEqual({ 1: 3, 2: 1, 4: 12 });
    expect(normalizeDaysOff(['2099-12-25', '2099-12-25', 'nope', '2000-01-01', '2099-02-30x'])).toEqual(['2099-12-25']);
  });

  it('keeps where a slot came from', () => {
    expect(normalizeSlots([{ day: 1, minute: 60, source: 'data' }, { day: 1, minute: 120, source: 'bogus' }])).toEqual([
      { day: 1, minute: 60, source: 'data' },
      { day: 1, minute: 120 },
    ]);
  });
});

describe('suggestions fill each day to its count', () => {
  const { fillDayTimes } = require('./slots');
  const cells = [
    { hour: 15, posts: 6, score: 45, avgEngagement: 44 },
    { hour: 9, posts: 6, score: 40, avgEngagement: 41 },
    { hour: 13, posts: 4, score: 30, avgEngagement: 31 },
    { hour: 20, posts: 1, score: 90 }, // one post: not enough
  ];

  it('a day with 1 of 3 gets exactly 2 suggestions, best first, away from what it has', () => {
    const out = fillDayTimes(1, cells, [15 * 60], 3, 20);
    expect(out.map((s: any) => [s.minute / 60, s.source])).toEqual([
      [9, 'data'],
      [13, 'data'],
    ]);
    expect(out[0].lift).toBe(1); // 40 vs 20 average = +100%
  });

  it('an empty day with a count of 3 gets 3, topping up with defaults', () => {
    const out = fillDayTimes(0, cells.slice(0, 1), [], 3, 20);
    expect(out).toHaveLength(3);
    expect(out.filter((s: any) => s.source === 'filler')).toHaveLength(2);
  });

  it('a full or over-full day gets nothing more', () => {
    expect(fillDayTimes(5, cells, [360, 420, 720], 3, 20)).toEqual([]);
    expect(fillDayTimes(5, cells, [360, 420, 720, 900], 3, 20)).toEqual([]);
  });

  it('matches what "Pick best times" chooses for an empty day', () => {
    const fill = fillDayTimes(2, cells, [], 3, 20).map((s: any) => s.minute);
    const pick = pickDayTimes(2, cells, 3, 20).map((s) => s.minute);
    expect(fill).toEqual(pick);
  });
});
