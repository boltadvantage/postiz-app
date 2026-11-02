// Bolt Advantage: what each client (Postiz customer / "group") and channel
// cost in metered API use over a date range, for invoicing.
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { csvCell } from '@gitroom/nestjs-libraries/bolt-analytics/csv';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { costOf, USAGE_KINDS, UsageKind, X_READ_USD, X_WRITE_USD } from '@gitroom/nestjs-libraries/bolt-costs/usage';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
const money = (n: number) => Math.round(n * 10000) / 10000;

export type Usage = Record<UsageKind, number>;
const emptyUsage = (): Usage => ({ history: 0, inbox: 0, dm: 0, write: 0 });
const costOfUsage = (u: Usage) => money(USAGE_KINDS.reduce((s, k) => s + costOf(k, u[k]), 0));
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
    for (const r of rows) {
      const u = usage.get(r.integrationId) || emptyUsage();
      if ((USAGE_KINDS as string[]).includes(r.kind)) u[r.kind as UsageKind] += r.units;
      usage.set(r.integrationId, u);
    }

    const clients = new Map<string, { id: string | null; name: string; usage: Usage; channels: any[] }>();
    for (const ch of channels) {
      const key = ch.customer && !ch.customer.deletedAt ? ch.customer.id : '';
      const client = clients.get(key) || { id: key || null, name: key ? ch.customer!.name : '', usage: emptyUsage(), channels: [] };
      const u = usage.get(ch.id) || emptyUsage();
      addInto(client.usage, u);
      client.channels.push({
        integrationId: ch.id,
        name: ch.name,
        platform: ch.providerIdentifier,
        picture: ch.picture,
        removed: !!ch.deletedAt,
        usage: u,
        cost: costOfUsage(u),
      });
      clients.set(key, client);
    }
    const total = emptyUsage();
    const list = [...clients.values()]
      .map((c) => {
        addInto(total, c.usage);
        return { ...c, cost: costOfUsage(c.usage), channels: c.channels.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)) };
      })
      // named clients first by cost, channels without a client last
      .sort((a, b) => Number(!a.id) - Number(!b.id) || b.cost - a.cost || a.name.localeCompare(b.name));

    return {
      from,
      to,
      prices: { xRead: X_READ_USD(), xWrite: X_WRITE_USD() },
      trackingSince: first?.date || null,
      clients: list,
      total: { usage: total, cost: costOfUsage(total) },
    };
  }

  /** One row per channel (or per channel per day with daily=true), ready to attach to an invoice. */
  async csv(organizationId: string, fromInput?: string, toInput?: string, daily = false) {
    const r = await this.report(organizationId, fromInput, toInput);
    const head = ['client', 'channel', 'platform', ...(daily ? ['date'] : []), 'history_reads', 'inbox_reads', 'dm_reads', 'posts_sent', 'estimated_cost_usd'];
    const line = (client: string, ch: any, u: Usage, date?: string) =>
      [client, `${ch.name}${ch.removed ? ' (removed)' : ''}`, ch.platform, ...(daily ? [date] : []), u.history, u.inbox, u.dm, u.write, costOfUsage(u).toFixed(4)]
        .map(csvCell)
        .join(',');
    const out = [head.join(',')];
    if (!daily) {
      for (const c of r.clients) for (const ch of c.channels) out.push(line(c.name || 'No client', ch, ch.usage));
    } else {
      const rows = await this._prisma.boltChannelUsage.findMany({
        where: { organizationId, date: { gte: r.from, lte: r.to } },
        orderBy: [{ date: 'asc' }],
      });
      for (const c of r.clients) {
        for (const ch of c.channels) {
          const byDay = new Map<string, Usage>();
          for (const row of rows.filter((x) => x.integrationId === ch.integrationId)) {
            const u = byDay.get(row.date) || emptyUsage();
            if ((USAGE_KINDS as string[]).includes(row.kind)) u[row.kind as UsageKind] += row.units;
            byDay.set(row.date, u);
          }
          for (const [date, u] of [...byDay.entries()].sort()) out.push(line(c.name || 'No client', ch, u, date));
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
