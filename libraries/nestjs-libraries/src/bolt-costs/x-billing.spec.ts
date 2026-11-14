const sets = new Map<string, Set<string>>();
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    multi: () => {
      const ops: Array<() => [null, number]> = [];
      const m: any = {
        sadd: (k: string, v: string) => {
          ops.push(() => {
            const s = sets.get(k) || new Set<string>();
            sets.set(k, s);
            const fresh = !s.has(v);
            s.add(v);
            return [null, fresh ? 1 : 0];
          });
          return m;
        },
        expire: () => (ops.push(() => [null, 1]), m),
        exec: async () => ops.map((f) => f()),
      };
      return m;
    },
  },
}));

import { budgetDay, chargeX, envBudget, hasLink, mergeBudget, priceX, saveXBudgetSettings, xBudgetLeft } from './x-billing';

const prices = { post: 0.005, user: 0.01, dm: 0.01, owned: 0.001, write: 0.015, writeUrl: 0.2 };

const fakePrisma = () => {
  const usage = new Map<string, { reads: number; usd: number }>();
  const ledger: any[] = [];
  let setting: string | null = null;
  const prisma: any = {
    boltSetting: {
      findUnique: jest.fn(async () => (setting ? { value: setting } : null)),
      upsert: jest.fn(async ({ create }: any) => (setting = create.value)),
    },
    integration: { findFirst: jest.fn(async () => ({ id: 'mine' })) },
    analyticsApiUsage: {
      findMany: jest.fn(async () => [...usage.entries()].map(([provider, v]) => ({ provider, ...v }))),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const cur = usage.get(where.provider_date.provider);
        usage.set(where.provider_date.provider, cur ? { reads: cur.reads + update.reads.increment, usd: cur.usd + update.usd.increment } : { reads: create.reads, usd: create.usd });
      }),
    },
    boltChannelUsage: { upsert: jest.fn(async ({ create }: any) => ledger.push(create)) },
  };
  return { prisma, usage, ledger };
};

describe('X billing', () => {
  const env = { ...process.env };
  beforeEach(() => {
    sets.clear();
    for (const k of Object.keys(process.env)) if (k.startsWith('BOLT_X_')) delete process.env[k];
  });
  afterAll(() => (process.env = env));

  it('bills each item once a day, and nothing for an empty answer', async () => {
    expect(await priceX({}, false, prices)).toEqual({ usd: 0, units: 0 });
    const first = await priceX({ dms: ['1', '2'], users: [{ id: 'u' }] }, false, prices);
    expect(first).toEqual({ usd: 0.03, units: 3 });
    // the same newest message and sender on the next check: already paid for today
    expect(await priceX({ dms: ['1'], users: [{ id: 'u' }] }, false, prices)).toEqual({ usd: 0, units: 0 });
  });

  it("charges the owner's own data at the owned price, other people's at the full price", async () => {
    const r = { posts: [{ id: 'm1', own: true }, { id: 'theirs' }], users: [{ id: 'fan' }] };
    expect((await priceX(r, true, prices)).usd).toBeCloseTo(0.001 + 0.005 + 0.01, 6);
    sets.clear();
    // not the app owner's channel: no discount
    expect((await priceX(r, false, prices)).usd).toBeCloseTo(0.005 + 0.005 + 0.01, 6);
  });

  it('prices things sent, with links costing more', async () => {
    expect(await priceX({ writes: 2, urlWrites: 1 }, false, prices)).toEqual({ usd: 0.23, units: 3 });
    expect(hasLink('see https://example.com')).toBe(true);
    expect(hasLink('read boltadvantage.com today')).toBe(true);
    expect(hasLink('e.g. the U.S. budget')).toBe(false);
  });

  it('turns the old read caps into dollars', () => {
    process.env.BOLT_X_DAILY_READS = '300';
    process.env.BOLT_X_INBOX_READS = '150';
    expect(envBudget()).toMatchObject({ dailyUsd: 1.5, inboxUsd: 0.75 });
    process.env.BOLT_X_DAILY_USD = '2';
    expect(envBudget().dailyUsd).toBe(2);
  });

  it('starts the budget day at midnight in the chosen time zone', () => {
    // 03:30 UTC on the 15th is still the evening of the 14th in Missouri
    const d = new Date('2026-11-15T03:30:00Z');
    expect(budgetDay('UTC', d)).toBe('2026-11-15');
    expect(budgetDay('America/Chicago', d)).toBe('2026-11-14');
    expect(budgetDay('Not/AZone', d)).toBe('2026-11-15');
    expect(mergeBudget(envBudget(), { timeZone: 'Nope' }).timeZone).toBe('UTC');
    expect(mergeBudget(envBudget(), { timeZone: 'America/Chicago' }).timeZone).toBe('America/Chicago');
  });

  it("keeps the inbox's share inside the daily budget and ignores nonsense", () => {
    const m = mergeBudget(envBudget(), { dailyUsd: 2, inboxUsd: 5, prices: { post: 'abc', dm: -1 } });
    expect(m.inboxUsd).toBe(2);
    expect(m.prices.post).toBe(0.005);
    expect(m.prices.dm).toBe(0.01);
  });

  it('saves settings and counts spending against the right share', async () => {
    const { prisma, usage, ledger } = fakePrisma();
    await expect(saveXBudgetSettings(prisma, { dailyUsd: 3, inboxUsd: 4 })).rejects.toThrow("can't be more");
    await expect(saveXBudgetSettings(prisma, { prices: { post: 5 } })).rejects.toThrow('between $0 and $1');
    await expect(saveXBudgetSettings(prisma, { timeZone: 'Mars/Olympus' })).rejects.toThrow('time zone');
    const s = await saveXBudgetSettings(prisma, { dailyUsd: 3, inboxUsd: 2, timeZone: 'America/Chicago' });
    expect(s).toMatchObject({ dailyUsd: 3, inboxUsd: 2, timeZone: 'America/Chicago' });

    // "mine" is the oldest X channel, so it's the app owner
    await chargeX(prisma, { id: 'mine', organizationId: 'o' }, 'inbox', 'x-inbox', { posts: [{ id: 'a', own: true }], users: [{ id: 'fan' }] });
    await chargeX(prisma, { id: 'mine', organizationId: 'o' }, 'write', 'x-write', { writes: 1 });
    expect(usage.get('x-inbox')!.usd).toBeCloseTo(0.011, 6);
    expect(ledger[0]).toMatchObject({ provider: 'x-billed', kind: 'inbox', units: 2 });
    // things sent come out of the inbox's share
    expect(await xBudgetLeft(prisma, 'x-inbox')).toBeCloseTo(2 - 0.011 - 0.015, 6);
    expect(await xBudgetLeft(prisma, 'x')).toBeCloseTo(1, 6);
  });
});
