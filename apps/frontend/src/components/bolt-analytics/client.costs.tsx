'use client';

// Bolt Advantage: what each client has cost in API fees this month (and last
// month for comparison), on the History page. Only X charges per call today;
// the full breakdown and CSV are on the Costs page. Admins only.
import React, { FC, useCallback } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

type Report = { clients: Array<{ id: string | null; name: string; cost: number }>; total: { cost: number } };

const money = (n: number) => '$' + n.toFixed(2);

export const ClientCosts: FC = () => {
  const t = useT();
  const fetch = useFetch();
  const load = useCallback(async (url: string) => {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as Report) : null;
  }, []);
  const monthStart = dayjs().startOf('month');
  const lastStart = monthStart.subtract(1, 'month');
  const { data: now } = useSWR(`/bolt-costs?from=${monthStart.format('YYYY-MM-DD')}&to=${dayjs().format('YYYY-MM-DD')}`, load);
  const { data: last } = useSWR(`/bolt-costs?from=${lastStart.format('YYYY-MM-DD')}&to=${monthStart.subtract(1, 'day').format('YYYY-MM-DD')}`, load);

  if (!now) return null;
  const key = (c: { id: string | null }) => c.id || '';
  const lastBy = new Map((last?.clients || []).map((c) => [key(c), c.cost]));
  const rows = [...now.clients]
    .map((c) => ({ ...c, last: lastBy.get(key(c)) ?? 0 }))
    // clients that cost something last month but nothing yet this month still show
    .concat((last?.clients || []).filter((c) => !now.clients.some((n) => key(n) === key(c))).map((c) => ({ ...c, cost: 0, last: c.cost })))
    .sort((a, b) => b.cost - a.cost || b.last - a.last || a.name.localeCompare(b.name));

  return (
    <div className="rounded-[8px] bg-newTableHeader p-[16px] flex flex-col gap-[10px]">
      <div className="flex items-center gap-[12px]">
        <div className="font-[500]">{t('client_api_costs', 'API costs by client')}</div>
        <div className="text-[12px] text-textItemBlur">{t('client_api_costs_help', 'X is the only platform that charges per call')}</div>
        <a href="/costs" className="ms-auto text-[13px] underline">
          {t('see_details', 'Details & CSV')}
        </a>
      </div>
      <table className="w-full text-[14px]">
        <thead>
          <tr className="text-[12px] text-textItemBlur">
            <th className="text-start font-normal pb-[6px]">{t('client', 'Client')}</th>
            <th className="text-end font-normal pb-[6px]">{t('month_to_date', '{{month}} so far', { month: monthStart.format('MMMM') })}</th>
            <th className="text-end font-normal pb-[6px]">{lastStart.format('MMMM')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={key(c)} className="border-t border-newTableBorder/60">
              <td className="py-[6px]">{c.name || t('no_client', 'No client')}</td>
              <td className="py-[6px] text-end tabular-nums">{money(c.cost)}</td>
              <td className="py-[6px] text-end tabular-nums text-textItemBlur">{money(c.last)}</td>
            </tr>
          ))}
          <tr className="border-t border-newTableBorder font-[500]">
            <td className="py-[6px]">{t('total', 'Total')}</td>
            <td className="py-[6px] text-end tabular-nums">{money(now.total.cost)}</td>
            <td className="py-[6px] text-end tabular-nums text-textItemBlur">{money(last?.total.cost || 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};
