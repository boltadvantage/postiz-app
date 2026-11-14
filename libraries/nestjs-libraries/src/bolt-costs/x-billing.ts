// Bolt Advantage: count X use the way X bills it, so the daily budget is real
// money. X charges per resource returned (an empty answer costs nothing), only
// once per resource per UTC day, and $0.001 for the app owner's own data read
// through their own app. Limits and prices are set in Settings, with the
// BOLT_X_* env values as the defaults. The budget's day starts at midnight in
// the time zone picked there; X's own once-a-day de-duplication stays on UTC.
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { dayKey } from '@gitroom/nestjs-libraries/bolt-analytics/schedule';
import { recordChannelUsage, UsageKind } from '@gitroom/nestjs-libraries/bolt-costs/usage';

export type XPrices = {
  /** a post someone else owns, or one not read through an owned endpoint */
  post: number;
  /** a profile */
  user: number;
  /** a direct message event */
  dm: number;
  /** the app owner's own posts, mentions and profile */
  owned: number;
  /** a post, reply, quote, repost, like or message sent */
  write: number;
  /** a post or reply with a link in it */
  writeUrl: number;
};

export type XBudgetSettings = {
  /** everything X may cost per UTC day */
  dailyUsd: number;
  /** the inbox's share (mentions + DMs + replies sent); History gets the rest */
  inboxUsd: number;
  /** the X channel whose account owns the developer app; null = the oldest X channel */
  ownerIntegrationId: string | null;
  /** the budget resets at midnight here (IANA name, e.g. America/Chicago) */
  timeZone: string;
  prices: XPrices;
};

/** Usage rows (AnalyticsApiUsage.provider): History, the inbox, and things sent. */
export type XPool = 'x' | 'x-inbox' | 'x-write';
/** BoltChannelUsage rows priced in dollars; older "x" rows are priced from units. */
export const X_BILLED_PROVIDER = 'x-billed';

const SETTINGS_KEY = 'x-budget';
const CACHE_MS = 30_000;
const MAX_DAILY_USD = 100;

const num = (v: unknown, fallback: number) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
/** A real IANA time zone, else the fallback. */
export function validZone(zone: unknown, fallback = 'UTC') {
  if (typeof zone !== 'string' || !zone) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

/** The budget day (YYYY-MM-DD) that `d` falls on in `zone`. */
export function budgetDay(zone: string, d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: validZone(zone), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const fromReads = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v) * 0.005);

/** Defaults from the environment; the old read caps convert at $0.005 a read. */
export function envBudget(): XBudgetSettings {
  const dailyUsd = num(process.env.BOLT_X_DAILY_USD, num(fromReads(process.env.BOLT_X_DAILY_READS), 1));
  const inboxUsd = Math.min(dailyUsd, num(process.env.BOLT_X_INBOX_USD, num(fromReads(process.env.BOLT_X_INBOX_READS), 0.5)));
  return {
    dailyUsd,
    inboxUsd,
    ownerIntegrationId: null,
    timeZone: validZone(process.env.BOLT_X_TIMEZONE),
    prices: {
      post: num(process.env.BOLT_X_READ_USD, 0.005),
      user: num(process.env.BOLT_X_USER_USD, 0.01),
      dm: num(process.env.BOLT_X_DM_USD, 0.01),
      owned: num(process.env.BOLT_X_OWNED_USD, 0.001),
      write: num(process.env.BOLT_X_WRITE_USD, 0.015),
      writeUrl: num(process.env.BOLT_X_WRITE_URL_USD, 0.2),
    },
  };
}

/** Saved values over the defaults; anything missing or nonsense falls back. */
export function mergeBudget(base: XBudgetSettings, saved: any): XBudgetSettings {
  const p = saved?.prices || {};
  const dailyUsd = Math.min(MAX_DAILY_USD, num(saved?.dailyUsd, base.dailyUsd));
  return {
    dailyUsd,
    inboxUsd: Math.min(dailyUsd, num(saved?.inboxUsd, base.inboxUsd)),
    ownerIntegrationId: typeof saved?.ownerIntegrationId === 'string' && saved.ownerIntegrationId ? saved.ownerIntegrationId : base.ownerIntegrationId,
    timeZone: validZone(saved?.timeZone, base.timeZone),
    prices: {
      post: Math.min(1, num(p.post, base.prices.post)),
      user: Math.min(1, num(p.user, base.prices.user)),
      dm: Math.min(1, num(p.dm, base.prices.dm)),
      owned: Math.min(1, num(p.owned, base.prices.owned)),
      write: Math.min(1, num(p.write, base.prices.write)),
      writeUrl: Math.min(1, num(p.writeUrl, base.prices.writeUrl)),
    },
  };
}

let cache: { at: number; value: XBudgetSettings } | null = null;

export async function xBudgetSettings(prisma: PrismaService): Promise<XBudgetSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await prisma.boltSetting.findUnique({ where: { key: SETTINGS_KEY } });
  let saved: any = null;
  try {
    saved = row ? JSON.parse(row.value) : null;
  } catch {
    saved = null;
  }
  const value = mergeBudget(envBudget(), saved);
  cache = { at: Date.now(), value };
  return value;
}

/** Checks and saves what an admin entered; returns the settings now in force. */
export async function saveXBudgetSettings(prisma: PrismaService, input: any) {
  const current = await xBudgetSettings(prisma);
  const bad = (v: unknown, max: number) => v !== undefined && v !== null && v !== '' && !(Number(v) >= 0 && Number(v) <= max);
  if (bad(input?.dailyUsd, MAX_DAILY_USD)) throw new Error(`The daily budget must be between $0 and $${MAX_DAILY_USD}`);
  const daily = num(input?.dailyUsd, current.dailyUsd);
  if (bad(input?.inboxUsd, daily)) throw new Error("The inbox's share can't be more than the daily budget");
  if (input?.timeZone !== undefined && input.timeZone !== null && input.timeZone !== '' && validZone(input.timeZone, '') !== input.timeZone) {
    throw new Error('Pick a time zone from the list');
  }
  for (const [k, v] of Object.entries(input?.prices || {})) {
    if (bad(v, 1)) throw new Error(`The ${k} price must be between $0 and $1`);
  }
  const next = mergeBudget(current, { ...input, prices: { ...current.prices, ...(input?.prices || {}) } });
  if (input && 'ownerIntegrationId' in input && !input.ownerIntegrationId) next.ownerIntegrationId = null;
  await prisma.boltSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  cache = { at: Date.now(), value: next };
  return next;
}

/** The channel whose X account owns the app: the chosen one, else the oldest X channel. */
export async function xOwnerIntegrationId(prisma: PrismaService) {
  const s = await xBudgetSettings(prisma);
  if (s.ownerIntegrationId) return s.ownerIntegrationId;
  const oldest = await prisma.integration.findFirst({
    where: { providerIdentifier: 'x', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return oldest?.id || null;
}

/** Dollars each pool may spend today. */
export const poolLimit = (s: XBudgetSettings, pool: Exclude<XPool, 'x-write'>) => (pool === 'x' ? Math.max(0, s.dailyUsd - s.inboxUsd) : s.inboxUsd);

/** What a pool has spent today; things sent count against the inbox. */
export async function spentToday(prisma: PrismaService) {
  const { timeZone } = await xBudgetSettings(prisma);
  const rows = await prisma.analyticsApiUsage.findMany({ where: { provider: { in: ['x', 'x-inbox', 'x-write'] }, date: budgetDay(timeZone) } });
  const usd = (p: XPool) => rows.find((r) => r.provider === p)?.usd || 0;
  return { history: usd('x'), inbox: usd('x-inbox') + usd('x-write'), total: usd('x') + usd('x-inbox') + usd('x-write') };
}

export async function xBudgetLeft(prisma: PrismaService, pool: Exclude<XPool, 'x-write'>) {
  const [s, spent] = await Promise.all([xBudgetSettings(prisma), spentToday(prisma)]);
  return Math.max(0, poolLimit(s, pool) - (pool === 'x' ? spent.history : spent.inbox));
}

/** What X returned or what was sent. `own` = the app owner's own data. */
export type XResources = {
  posts?: Array<{ id: string; own?: boolean }>;
  users?: Array<{ id: string; own?: boolean }>;
  dms?: string[];
  writes?: number;
  urlWrites?: number;
};

/** Of these keys, the ones not yet billed today (and marks them billed). */
export async function firstToday(keys: string[]) {
  if (!keys.length) return new Set<string>();
  const k = `bolt:xbill:${dayKey()}`;
  try {
    const multi = ioRedis.multi();
    keys.forEach((m) => multi.sadd(k, m));
    multi.expire(k, 3 * 86400);
    const res = await multi.exec();
    return new Set(keys.filter((_, i) => Number(res?.[i]?.[1]) === 1));
  } catch {
    // Redis down: count everything, which errs on the side of spending less
    return new Set(keys);
  }
}

/** Dollars and billed items for one response, after same-day de-duplication. */
export async function priceX(r: XResources, owner: boolean, prices: XPrices) {
  const posts = new Map((r.posts || []).map((p) => [`p:${p.id}`, owner && !!p.own]));
  const users = new Map((r.users || []).map((u) => [`u:${u.id}`, owner && !!u.own]));
  const dms = (r.dms || []).map((id) => `d:${id}`);
  const fresh = await firstToday([...posts.keys(), ...users.keys(), ...new Set(dms)]);
  let usd = 0;
  for (const key of fresh) {
    if (posts.has(key)) usd += posts.get(key) ? prices.owned : prices.post;
    else if (users.has(key)) usd += users.get(key) ? prices.owned : prices.user;
    else usd += prices.dm;
  }
  const writes = r.writes || 0;
  const urlWrites = r.urlWrites || 0;
  usd += writes * prices.write + urlWrites * prices.writeUrl;
  return { usd: Math.round(usd * 1e6) / 1e6, units: fresh.size + writes + urlWrites };
}

/** Price a response, count it against today's pool and on the channel's cost ledger. */
export async function chargeX(
  prisma: PrismaService,
  integration: { id: string; organizationId: string },
  kind: UsageKind,
  pool: XPool,
  r: XResources
) {
  const [s, ownerId] = await Promise.all([xBudgetSettings(prisma), xOwnerIntegrationId(prisma)]);
  const { usd, units } = await priceX(r, ownerId === integration.id, s.prices);
  if (!units) return 0;
  await recordChannelUsage(prisma, integration, kind, units, X_BILLED_PROVIDER, usd);
  const date = budgetDay(s.timeZone);
  await prisma.analyticsApiUsage.upsert({
    where: { provider_date: { provider: pool, date } },
    create: { provider: pool, date, reads: units, usd },
    update: { reads: { increment: units }, usd: { increment: usd } },
  });
  return usd;
}

/** X turns these into links (and charges a link post's price). */
export const hasLink = (text: string) => /https?:\/\/\S|\bwww\.\S|\b[a-z0-9-]+\.(com|org|net|io|co|gov|edu|us|me|ly|app|dev|news|tv)\b/i.test(text || '');

/** Worst-case cost of one more item, for sizing a request to what's left. */
export const worstItem = (p: XPrices, what: 'mention' | 'dm' | 'post') =>
  what === 'mention' ? p.post * 2 + p.user : what === 'dm' ? p.dm + p.user : p.post;
