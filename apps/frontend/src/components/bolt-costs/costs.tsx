'use client';

// Bolt Advantage: what each client cost in metered API use over a date range,
// grouped by Postiz customer ("group"), with a CSV to attach to an invoice.
import React, { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

type Usage = { history: number; inbox: number; dm: number; write: number };
type Channel = { integrationId: string; name: string; platform: string; picture: string | null; removed: boolean; usage: Usage; cost: number };
type Client = { id: string | null; name: string; usage: Usage; cost: number; channels: Channel[] };
type Report = {
  from: string;
  to: string;
  prices: { post: number; user: number; dm: number; owned: number; write: number; writeUrl: number };
  trackingSince: string | null;
  clients: Client[];
  total: { usage: Usage; cost: number };
};

const F = 'YYYY-MM-DD';
const PRESETS = [
  { key: 'this_month', label: 'This month', range: () => [dayjs().startOf('month'), dayjs()] },
  { key: 'last_month', label: 'Last month', range: () => [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
  { key: 'last_30', label: 'Last 30 days', range: () => [dayjs().subtract(29, 'day'), dayjs()] },
  { key: 'this_year', label: 'This year', range: () => [dayjs().startOf('year'), dayjs()] },
] as const;
const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);
const num = (n: number) => (n ? n.toLocaleString() : '–');

const Row: FC<{ label: React.ReactNode; u: Usage; cost: number; strong?: boolean }> = ({ label, u, cost, strong }) => (
  <tr className={clsx('border-t border-newTableBorder', strong && 'font-[600]')}>
    <td className="py-[8px] pe-[12px]">{label}</td>
    <td className="py-[8px] px-[8px] text-end tabular-nums">{num(u.history)}</td>
    <td className="py-[8px] px-[8px] text-end tabular-nums">{num(u.inbox)}</td>
    <td className="py-[8px] px-[8px] text-end tabular-nums">{num(u.dm)}</td>
    <td className="py-[8px] px-[8px] text-end tabular-nums">{num(u.write)}</td>
    <td className="py-[8px] ps-[8px] text-end tabular-nums">{usd(cost)}</td>
  </tr>
);

export const Costs = () => {
  const t = useT();
  const fetch = useFetch();
  const { backendUrl } = useVariables();
  const [preset, setPreset] = useState<string>('this_month');
  const initial = PRESETS[0].range();
  const [from, setFrom] = useState(initial[0].format(F));
  const [to, setTo] = useState(initial[1].format(F));
  const get = useCallback(async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);
  const { data, error } = useSWR<Report>(`/bolt-costs?from=${from}&to=${to}`, get);
  const pick = (key: string) => {
    const p = PRESETS.find((x) => x.key === key)!;
    const [a, b] = p.range();
    setPreset(key);
    setFrom(a.format(F));
    setTo(b.format(F));
  };
  const named = useMemo(() => (data?.clients || []).filter((c) => c.id), [data]);
  const csv = (daily: boolean) => `${backendUrl}/bolt-costs/export.csv?from=${from}&to=${to}${daily ? '&daily=true' : ''}`;

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] overflow-y-auto">
      <div className="flex flex-wrap items-center gap-[10px]">
        <h2 className="text-[20px] font-[500] me-auto">{t('client_costs', 'Client costs')}</h2>
        <div className="flex rounded-[8px] border border-newTableBorder overflow-hidden text-[13px]">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => pick(p.key)} className={clsx('px-[10px] h-[34px] whitespace-nowrap', preset === p.key ? 'bg-[#612BD3] text-white' : 'hover:bg-newTableHeader')}>
              {t(`costs_${p.key}`, p.label)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-[6px] text-[13px]">
          <input type="date" value={from} max={to} onChange={(e) => (setPreset(''), setFrom(e.target.value))} className="bg-newTableHeader border border-newTableBorder rounded-[6px] h-[34px] px-[8px]" />
          –
          <input type="date" value={to} min={from} onChange={(e) => (setPreset(''), setTo(e.target.value))} className="bg-newTableHeader border border-newTableBorder rounded-[6px] h-[34px] px-[8px]" />
        </label>
        <a href={csv(true)} className="px-[12px] h-[34px] rounded-[8px] border border-newTableBorder text-[13px] flex items-center whitespace-nowrap">
          {t('csv_by_day', 'CSV by day')}
        </a>
        <a href={csv(false)} className="px-[12px] h-[34px] rounded-[8px] bg-[#612BD3] text-white text-[13px] flex items-center whitespace-nowrap">
          {t('download_csv', 'Download CSV')}
        </a>
      </div>

      {error ? (
        <div className="text-[14px] text-red-400">{String(error.message || error)}</div>
      ) : !data ? (
        <LoadingComponent />
      ) : (
        <>
          <div className="grid grid-cols-3 mobile:grid-cols-1 gap-[12px]">
            <div className="rounded-[8px] bg-newTableHeader p-[14px]">
              <div className="text-[12px] text-textItemBlur">{t('total_estimated', 'Total, estimated')}</div>
              <div className="text-[26px] font-[600]">{usd(data.total.cost)}</div>
              <div className="text-[12px] text-textItemBlur">
                {dayjs(data.from).format('MMM D, YYYY')} – {dayjs(data.to).format('MMM D, YYYY')}
              </div>
            </div>
            {named.slice(0, 2).map((c) => (
              <div key={c.id} className="rounded-[8px] bg-newTableHeader p-[14px]">
                <div className="text-[12px] text-textItemBlur truncate">{c.name}</div>
                <div className="text-[26px] font-[600]">{usd(c.cost)}</div>
                <div className="text-[12px] text-textItemBlur">{t('channels_n', '{{n}} channels', { n: c.channels.length })}</div>
              </div>
            ))}
          </div>

          {data.clients.length === 0 ? (
            <div className="text-[14px] text-textItemBlur py-[20px] text-center">{t('no_metered_channels', 'No X channels yet. Nostr is free, so it has no costs to track.')}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] min-w-[640px]">
                <thead>
                  <tr className="text-textItemBlur text-[12px]">
                    <th className="text-start font-[400] pb-[6px]">{t('client_channel', 'Client / channel')}</th>
                    <th className="text-end font-[400] pb-[6px] px-[8px]" title={t('history_reads_hint', 'Saved post stats and follower totals')}>{t('history', 'History')}</th>
                    <th className="text-end font-[400] pb-[6px] px-[8px]" title={t('inbox_reads_hint', 'Checking mentions and replies')}>{t('inbox', 'Inbox')}</th>
                    <th className="text-end font-[400] pb-[6px] px-[8px]" title={t('dm_reads_hint', 'Checking direct messages')}>{t('messages', 'Messages')}</th>
                    <th className="text-end font-[400] pb-[6px] px-[8px]" title={t('writes_hint', 'Replies, reposts, quotes and messages sent')}>{t('sent', 'Sent')}</th>
                    <th className="text-end font-[400] pb-[6px]">{t('est_cost', 'Est. cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <React.Fragment key={c.id || 'none'}>
                      <Row strong u={c.usage} cost={c.cost} label={c.id ? c.name : <span className="text-textItemBlur">{t('no_client', 'Not assigned to a client')}</span>} />
                      {c.channels.map((ch) => (
                        <Row
                          key={ch.integrationId}
                          u={ch.usage}
                          cost={ch.cost}
                          label={
                            <span className="flex items-center gap-[8px] ps-[16px]">
                              <img src={ch.picture || `/icons/platforms/${ch.platform}.png`} className="w-[18px] h-[18px] rounded-full" alt="" />
                              <span className="truncate">{ch.name}</span>
                              {ch.removed && <span className="text-[11px] text-textItemBlur">({t('removed', 'removed')})</span>}
                            </span>
                          }
                        />
                      ))}
                    </React.Fragment>
                  ))}
                  <Row strong u={data.total.usage} cost={data.total.cost} label={t('total', 'Total')} />
                </tbody>
              </table>
            </div>
          )}

          <div className="text-[12px] text-textItemBlur flex flex-col gap-[4px]">
            <span>
              {t('costs_prices_v2', 'Estimated at X’s prices: ${{post}} a post, ${{user}} a profile, ${{dm}} a message, ${{owned}} for your own account’s data, ${{write}} per thing sent. Each item is billed once a day. Change the prices in Settings; your X developer console has the actual bill.', {
                post: data.prices.post,
                user: data.prices.user,
                dm: data.prices.dm,
                owned: data.prices.owned,
                write: data.prices.write,
              })}
            </span>
            <span>
              {data.trackingSince
                ? t('costs_since', 'Per-channel tracking started {{date}}; nothing before that is included.', { date: dayjs(data.trackingSince).format('MMM D, YYYY') })
                : t('costs_not_yet', 'Per-channel tracking starts with the next X check; nothing before that is included.')}
            </span>
            <span>
              {t('costs_assign', 'To group channels by client, open a channel’s menu on the')}{' '}
              <Link href="/launches" className="underline">{t('calendar', 'Calendar')}</Link>{' '}
              {t('costs_assign2', 'and choose “Move / add to group”.')}
            </span>
          </div>
        </>
      )}
    </div>
  );
};
