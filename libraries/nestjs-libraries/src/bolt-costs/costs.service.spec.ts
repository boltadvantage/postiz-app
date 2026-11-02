jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({ ioRedis: {} }));
import { CostsService, costRange } from './costs.service';

const usageRows = [
  { provider: 'x', integrationId: 'x1', kind: 'history', units: 100, date: '2026-11-01' },
  { provider: 'x', integrationId: 'x1', kind: 'inbox', units: 60, date: '2026-11-01' },
  { provider: 'x', integrationId: 'x1', kind: 'write', units: 3, date: '2026-11-02' },
  { provider: 'x', integrationId: 'x2', kind: 'inbox', units: 40, date: '2026-11-02' },
  { provider: 'x', integrationId: 'gone', kind: 'dm', units: 10, date: '2026-11-02' },
];
const channels = [
  { id: 'x1', name: 'Client A X', picture: null, providerIdentifier: 'x', deletedAt: null, customer: { id: 'cA', name: 'Client A', deletedAt: null } },
  { id: 'x2', name: 'My X', picture: null, providerIdentifier: 'x', deletedAt: null, customer: null },
  { id: 'gone', name: 'Old X', picture: null, providerIdentifier: 'x', deletedAt: new Date(), customer: { id: 'cA', name: 'Client A', deletedAt: null } },
  { id: 'x3', name: 'Quiet X', picture: null, providerIdentifier: 'x', deletedAt: null, customer: { id: 'cB', name: 'Client B', deletedAt: null } },
];
const prisma: any = {
  boltChannelUsage: {
    findMany: jest.fn(async () => usageRows),
    findFirst: jest.fn(async () => ({ date: '2026-11-01' })),
  },
  integration: { findMany: jest.fn(async () => channels) },
  boltSetting: { findUnique: jest.fn(async () => null) },
  analyticsApiUsage: { findMany: jest.fn(async () => [{ provider: 'x-inbox', usd: 0.25 }]) },
};

describe('client costs', () => {
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.BOLT_X_READ_USD;
    delete process.env.BOLT_X_WRITE_USD;
  });
  afterAll(() => (process.env = env));

  it('groups channels by client, counts removed channels, and prices reads and posts', async () => {
    const r = await new CostsService(prisma).report('org', '2026-11-01', '2026-11-30');
    const a = r.clients.find((c) => c.id === 'cA')!;
    expect(a.usage).toEqual({ history: 100, inbox: 60, dm: 10, write: 3 });
    // 170 reads x $0.005 + 3 posts x $0.01
    expect(a.cost).toBeCloseTo(0.88, 4);
    expect(a.channels.map((c: any) => [c.name, c.removed])).toEqual([
      ['Client A X', false],
      ['Old X', true],
    ]);
    expect(r.clients.find((c) => c.id === 'cB')!.cost).toBe(0);
    // channels without a client come last
    expect(r.clients[r.clients.length - 1].id).toBeNull();
    expect(r.total.cost).toBeCloseTo(0.88 + 0.2, 4);
    expect(r.trackingSince).toBe('2026-11-01');
  });

  it('uses your prices when set', async () => {
    process.env.BOLT_X_READ_USD = '0.01';
    process.env.BOLT_X_WRITE_USD = '0';
    const r = await new CostsService(prisma).report('org', '2026-11-01', '2026-11-30');
    expect(r.total.cost).toBeCloseTo(2.1, 4);
  });

  it('CSV has one row per channel plus a total, and a by-day version', async () => {
    const svc = new CostsService(prisma);
    const { body, filename } = await svc.csv('org', '2026-11-01', '2026-11-30');
    const lines = body.trim().split('\n');
    expect(filename).toBe('postiz-costs-2026-11-01-to-2026-11-30.csv');
    expect(lines[0]).toBe('client,channel,platform,history_reads,inbox_reads,dm_reads,posts_sent,estimated_cost_usd');
    expect(lines).toContain('Client A,Client A X,x,100,60,0,3,0.8300');
    expect(lines).toContain('Client A,Old X (removed),x,0,0,10,0,0.0500');
    expect(lines[lines.length - 1]).toBe('TOTAL,,,100,100,10,3,1.0800');
    const daily = (await svc.csv('org', '2026-11-01', '2026-11-30', true)).body;
    expect(daily).toContain('Client A,Client A X,x,2026-11-01,100,60,0,0,0.8000');
    expect(daily).toContain('Client A,Client A X,x,2026-11-02,0,0,0,3,0.0300');
  });

  it('uses the dollars on newer rows instead of pricing their units', async () => {
    const rows = [...usageRows, { provider: 'x-billed', integrationId: 'x3', kind: 'inbox', units: 50, usd: 0.07, date: '2026-11-03' }];
    const p = { ...prisma, boltChannelUsage: { ...prisma.boltChannelUsage, findMany: jest.fn(async () => rows) } };
    const r = await new CostsService(p).report('org', '2026-11-01', '2026-11-30');
    expect(r.clients.find((c) => c.id === 'cB')!.cost).toBeCloseTo(0.07, 4);
    expect(r.total.cost).toBeCloseTo(1.08 + 0.07, 4);
    expect(r.xBudget.spentToday.inbox).toBeCloseTo(0.25, 4);
  });

  it('checks the date range', () => {
    expect(() => costRange('2026-12-01', '2026-11-01')).toThrow('after the end');
    expect(() => costRange('2024-01-01', '2026-11-01')).toThrow('at most');
    expect(costRange('bad', 'also bad').from).toMatch(/^\d{4}-\d{2}-01$/);
  });
});
