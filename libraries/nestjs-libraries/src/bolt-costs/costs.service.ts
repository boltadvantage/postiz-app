// Bolt Advantage: what each client (Postiz customer / "group") and channel
// cost in metered API use over a date range, for invoicing.
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { csvCell } from '@gitroom/nestjs-libraries/bolt-analytics/csv';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { rowCost, USAGE_KINDS, UsageKind } from '@gitroom/nestjs-libraries/bolt-costs/usage';
import { poolLimit, spentToday, xBudgetSettings } from '@gitroom/nestjs-libraries/bolt-costs/x-billing';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
const money = (n: number) => Math.round(n * 10000) / 10000;

export type Usage = Record<UsageKind, number>;
const emptyUsage = (): Usage => ({ history: 0, inbox: 0, dm: 0, write: 0 });
const addInto = (into: Usage, from: Usage) => USAGE_KINDS.forEach((k) => (into[k] += from[k]));

/** Inclusive YYYY-MM-DD range; defaults to this month so far. Throws on nonsense. */
export function costRange(from?: string, to?: string) {
  const f = from && DATE.test(from) ? from : dayjs().startOf('month').format('YYYY-MM-DD');
  const t = to && DATE.test(to) ? to : dayjs().format('YYYY-MM-DD');
  if (!dayjs(f).isValid() || !dayjs(t).isValid()) throw new Error('Dates must be YYYY-MM-DD');
  if (f > t) throw new Error('The start date is after the end date');
  if (dayjs(t).diff(dayjs(f), 'day') > MAX_DAYS) throw new Error(`Pick at most ${MAX_DAYS} days`);
  return { from: f, to: t };
}

@Injectable()
export class CostsService {
  constructor(private _prisma: PrismaService) {}

  async report(organizationId: string, fromInput?: string, toInput?: string) {
    const { from, to } = costRange(fromInput, toInput);
    const [rows, first] = await Promise.all([
      this._prisma.boltChannelUsage.findMany({ where: { organizationId, date: { gte: from, lte: to } } }),
      this._prisma.boltChannelUsage.findFirst({ where: { organizationId }, orderBy: { date: 'asc' }, select: { date: true } }),
    ]);
    const used = [...new Set(rows.map((r) => r.integrationId))];
    // metered channels (X) show even at $0; removed channels show when they were used in the period
    const channels = await this._prisma.integration.findMany({
      where: {
        organizationId,
        OR: [{ id: { in: used } }, { deletedAt: null, providerIdentifier: 'x' }],
      },
      select: { id: true, name: true, picture: true, providerIdentifier: true, deletedAt: true, customer: { select: { id: true, name: true, deletedAt: true } } },
    });

    const usage = new Map<string, Usage>();
    const spend = new Map<string, number>();
    for (const r of rows) {
      const u = usage.get(r.integrationId) || emptyUsage();
      if ((USAGE_KINDS as string[]).includes(r.kind)) u[r.kind as UsageKind] += r.units;
      usage.set(r.integrationId, u);
      spend.set(r.integrationId, (spend.get(r.integrationId) || 0) + rowCost(r));
    }

    const clients = new Map<string, { id: string | null; name: string; usage: Usage; cost: number; channels: any[] }>();
    for (const ch of channels) {
      const key = ch.customer && !ch.customer.deletedAt ? ch.customer.id : '';
      const client = clients.get(key) || { id: key || null, name: key ? ch.customer!.name : '', usage: emptyUsage(), cost: 0, channels: [] };
      const u = usage.get(ch.id) || emptyUsage();
      const cost = money(spend.get(ch.id) || 0);
      addInto(client.usage, u);
      client.cost += cost;
      client.channels.push({
        integrationId: ch.id,
        name: ch.name,
        platform: ch.providerIdentifier,
        picture: ch.picture,
        removed: !!ch.deletedAt,
        usage: u,
        cost,
      });
      clients.set(key, client);
    }
    const total = emptyUsage();
    let totalCost = 0;
    const list = [...clients.values()]
      .map((c) => {
        addInto(total, c.usage);
        totalCost += c.cost;
        return { ...c, cost: money(c.cost), channels: c.channels.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)) };
      })
      // named clients first by cost, channels without a client last
      .sort((a, b) => Number(!a.id) - Number(!b.id) || b.cost - a.cost || a.name.localeCompare(b.name));

    const [budget, today] = await Promise.all([xBudgetSettings(this._prisma), spentToday(this._prisma)]);
    return {
      from,
      to,
      prices: budget.prices,
      // install-wide, so the same for every workspace
      xBudget: {
        dailyUsd: budget.dailyUsd,
        inboxUsd: poolLimit(budget, 'x-inbox'),
        historyUsd: poolLimit(budget, 'x'),
        spentToday: { inbox: money(today.inbox), history: money(today.history), total: money(today.total) },
      },
      trackingSince: first?.date || null,
      clients: list,
      total: { usage: total, cost: money(totalCost) },
    };
  }

  /** One row per channel (or per channel per day with daily=true), ready to attach to an invoice. */
  async csv(organizationId: string, fromInput?: string, toInput?: string, daily = false) {
    const r = await this.report(organizationId, fromInput, toInput);
    const head = ['client', 'channel', 'platform', ...(daily ? ['date'] : []), 'history_reads', 'inbox_reads', 'dm_reads', 'posts_sent', 'estimated_cost_usd'];
    const line = (client: string, ch: any, u: Usage, cost: number, date?: string) =>
      [client, `${ch.name}${ch.removed ? ' (removed)' : ''}`, ch.platform, ...(daily ? [date] : []), u.history, u.inbox, u.dm, u.write, cost.toFixed(4)]
        .map(csvCell)
        .join(',');
    const out = [head.join(',')];
    if (!daily) {
      for (const c of r.clients) for (const ch of c.channels) out.push(line(c.name || 'No client', ch, ch.usage, ch.cost));
    } else {
      const rows = await this._prisma.boltChannelUsage.findMany({
        where: { organizationId, date: { gte: r.from, lte: r.to } },
        orderBy: [{ date: 'asc' }],
      });
      for (const c of r.clients) {
        for (const ch of c.channels) {
          const byDay = new Map<string, { u: Usage; cost: number }>();
          for (const row of rows.filter((x) => x.integrationId === ch.integrationId)) {
            const d = byDay.get(row.date) || { u: emptyUsage(), cost: 0 };
            if ((USAGE_KINDS as string[]).includes(row.kind)) d.u[row.kind as UsageKind] += row.units;
            d.cost += rowCost(row);
            byDay.set(row.date, d);
          }
          for (const [date, d] of [...byDay.entries()].sort()) out.push(line(c.name || 'No client', ch, d.u, money(d.cost), date));
        }
      }
    }
    out.push(
      ['TOTAL', '', '', ...(daily ? [''] : []), r.total.usage.history, r.total.usage.inbox, r.total.usage.dm, r.total.usage.write, r.total.cost.toFixed(4)]
        .map(csvCell)
        .join(',')
    );
    return { filename: `postiz-costs-${r.from}-to-${r.to}.csv`, body: out.join('\n') + '\n' };
  }
}
