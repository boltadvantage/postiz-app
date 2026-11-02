// Bolt Advantage: metered API use recorded per channel per day, so costs can
// be reported (and invoiced) per client. The install-wide daily caps still
// run on AnalyticsApiUsage; this is the per-channel ledger beside it.
import type { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { dayKey } from '@gitroom/nestjs-libraries/bolt-analytics/schedule';

/** history = saved stats and followers, inbox = mentions, dm = direct messages, write = replies/reposts/quotes/likes/messages sent */
export type UsageKind = 'history' | 'inbox' | 'dm' | 'write';
export const USAGE_KINDS: UsageKind[] = ['history', 'inbox', 'dm', 'write'];

const price = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
// Rows recorded before X use was priced in dollars (provider "x") are priced
// from their units at these rates; newer rows carry their own dollars.
export const X_READ_USD = () => price(process.env.BOLT_X_READ_USD, 0.005);
export const X_WRITE_USD = () => price(process.env.BOLT_X_WRITE_USD, 0.01);

/** A ledger row's dollars: its own for newer rows, units at the old rates for older ones. */
export const rowCost = (r: { provider: string; kind: string; units: number; usd?: number | null }) =>
  r.provider === 'x' ? costOf(r.kind as UsageKind, r.units) : r.usd || 0;

export const costOf = (kind: UsageKind, units: number) => units * (kind === 'write' ? X_WRITE_USD() : X_READ_USD());

export async function recordChannelUsage(
  prisma: PrismaService,
  integration: { id: string; organizationId: string },
  kind: UsageKind,
  units: number,
  provider = 'x',
  usd = 0
) {
  if (!units) return;
  const date = dayKey();
  await prisma.boltChannelUsage.upsert({
    where: { integrationId_provider_kind_date: { integrationId: integration.id, provider, kind, date } },
    create: { organizationId: integration.organizationId, integrationId: integration.id, provider, kind, date, units, usd },
    update: { units: { increment: units }, usd: { increment: usd } },
  });
}
