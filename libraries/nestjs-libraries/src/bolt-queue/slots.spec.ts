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
