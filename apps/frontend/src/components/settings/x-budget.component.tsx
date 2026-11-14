'use client';

// Bolt Advantage: the X budget — how much X may cost per day, the inbox's share
// of it, which account owns the X developer app, and X's prices.
import React, { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';

type Prices = { post: number; user: number; dm: number; owned: number; write: number; writeUrl: number };
interface Budget {
  dailyUsd: number;
  inboxUsd: number;
  historyUsd: number;
  ownerIntegrationId: string | null;
  timeZone: string;
  effectiveOwnerId: string | null;
  prices: Prices;
  spentToday: { history: number; inbox: number; total: number };
  xChannels: { id: string; name: string; picture: string | null }[];
}

const btn = 'rounded-[8px] !h-[36px] !px-[16px] text-[14px] whitespace-nowrap shrink-0';
const input =
  'bg-newBgColorInner h-[38px] border-newTableBorder border rounded-[8px] px-[12px] text-[14px] text-textColor outline-none';

const PRICE_LABELS: [keyof Prices, string, string][] = [
  ['post', 'x_price_post', 'A post'],
  ['user', 'x_price_user', 'A profile'],
  ['dm', 'x_price_dm', 'A direct message'],
  ['owned', 'x_price_owned', 'Your own account’s posts, mentions and profile'],
  ['write', 'x_price_write', 'Each reply, repost, like or message sent'],
  ['writeUrl', 'x_price_write_url', 'A reply or quote with a link'],
];

const browserZone = () => (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');
const allZones = (): string[] => {
  try {
    return (Intl as any).supportedValuesOf('timeZone');
  } catch {
    return [browserZone(), 'UTC'];
  }
};

const Money = ({ value, onChange, step = '0.01' }: { value: string; onChange: (v: string) => void; step?: string }) => (
  <div className="flex items-center gap-[6px]">
    <span className="text-textItemBlur">$</span>
    <input
      type="number"
      min="0"
      step={step}
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${input} w-[110px]`}
    />
  </div>
);

const XBudgetComponent = () => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const user = useUser();
  const isAdmin = !!user && user.role !== 'USER';

  const load = useCallback(async () => {
    const res = await fetch('/bolt-costs/x-budget');
    return res.status >= 400 ? null : res.json();
  }, []);
  const { data, mutate } = useSWR<Budget | null>(isAdmin ? 'x-budget' : null, load, { revalidateOnFocus: false });

  const [daily, setDaily] = useState('');
  const [inbox, setInbox] = useState('');
  const [owner, setOwner] = useState('');
  const [zone, setZone] = useState('UTC');
  const [prices, setPrices] = useState<Record<keyof Prices, string>>({ post: '', user: '', dm: '', owned: '', write: '', writeUrl: '' });
  const [showPrices, setShowPrices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!data) return;
    setDaily(String(data.dailyUsd));
    setInbox(String(data.inboxUsd));
    setOwner(data.ownerIntegrationId || '');
    setZone(data.timeZone || 'UTC');
    setPrices(Object.fromEntries(Object.entries(data.prices).map(([k, v]) => [k, String(v)])) as any);
  }, [data]);

  const save = useCallback(async () => {
    setBusy(true);
    setError('');
    const res = await fetch('/bolt-costs/x-budget', {
      method: 'PUT',
      body: JSON.stringify({
        dailyUsd: Number(daily),
        inboxUsd: Number(inbox),
        ownerIntegrationId: owner || null,
        timeZone: zone,
        prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, Number(v)])),
      }),
    });
    setBusy(false);
    if (res.status >= 400) {
      const text = await res.text();
      try {
        setError(JSON.parse(text).message || text);
      } catch {
        setError(text);
      }
      return;
    }
    await mutate(await res.json(), { revalidate: false });
    toaster.show(t('x_budget_saved', 'X budget saved'), 'success');
  }, [daily, inbox, owner, zone, prices]);

  if (!isAdmin || !data) return null;

  const history = Math.max(0, (Number(daily) || 0) - (Number(inbox) || 0));
  const autoOwner = data.xChannels.find((c) => c.id === data.effectiveOwnerId);

  return (
    <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[16px]">
      <div>
        <div>{t('x_budget_title', 'X budget')}</div>
        <div className="text-[14px] text-textItemBlur mt-[4px]">
          {t(
            'x_budget_status',
            'Today so far: ${{total}} (inbox ${{inbox}} of ${{inboxCap}}, History ${{history}} of ${{historyCap}}). Resets at midnight, {{zone}}.',
            {
              zone: data.timeZone,
              total: data.spentToday.total.toFixed(2),
              inbox: data.spentToday.inbox.toFixed(2),
              inboxCap: data.inboxUsd.toFixed(2),
              history: data.spentToday.history.toFixed(2),
              historyCap: data.historyUsd.toFixed(2),
            }
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-[24px] text-[14px]">
        <label className="flex flex-col gap-[6px]">
          <span>{t('x_budget_daily', 'Most X may cost per day')}</span>
          <Money value={daily} onChange={setDaily} />
        </label>
        <label className="flex flex-col gap-[6px]">
          <span>{t('x_budget_inbox', 'Of that, for the inbox')}</span>
          <Money value={inbox} onChange={setInbox} />
        </label>
        <div className="flex flex-col gap-[6px]">
          <span>{t('x_budget_history', 'Left for History')}</span>
          <span className="h-[38px] flex items-center text-textItemBlur">${history.toFixed(2)}</span>
        </div>
      </div>
      <label className="flex flex-col gap-[6px] text-[14px]">
        <span>{t('x_budget_zone', 'A new day starts at midnight in')}</span>
        <div className="flex flex-wrap items-center gap-[8px]">
          <select value={zone} onChange={(e) => setZone(e.target.value)} className={`${input} max-w-[360px]`}>
            {Array.from(new Set([zone, ...allZones(), 'UTC'])).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          {zone !== browserZone() && (
            <button type="button" className="text-[13px] underline" onClick={() => setZone(browserZone())}>
              {t('x_budget_zone_mine', 'Use mine ({{zone}})', { zone: browserZone() })}
            </button>
          )}
        </div>
      </label>
      <div className="text-[13px] text-textItemBlur -mt-[8px]">
        {t(
          'x_budget_inbox_help',
          'The inbox covers checking mentions and messages and the replies you send. When its share runs out, X waits until tomorrow; Nostr keeps going.'
        )}
      </div>

      {data.xChannels.length > 0 && (
        <label className="flex flex-col gap-[6px] text-[14px]">
          <span>{t('x_budget_owner', 'X account that owns your developer app')}</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={`${input} max-w-[360px]`}>
            <option value="">
              {t('x_budget_owner_auto', 'Automatic: {{name}}', { name: autoOwner?.name || t('none', 'none') })}
            </option>
            {data.xChannels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="text-[13px] text-textItemBlur">
            {t('x_budget_owner_help', 'X charges ${{owned}} instead of ${{post}} when this account reads its own posts and mentions.', {
              owned: data.prices.owned,
              post: data.prices.post,
            })}
          </span>
        </label>
      )}

      <div className="flex flex-col gap-[12px]">
        <button type="button" className="text-[14px] underline self-start" onClick={() => setShowPrices((v) => !v)}>
          {showPrices ? t('x_prices_hide', 'Hide X prices') : t('x_prices_show', 'X prices')}
        </button>
        {showPrices && (
          <>
            <div className="text-[13px] text-textItemBlur">
              {t(
                'x_prices_help',
                'What X charges per item. X bills each item once a day, so re-reading the same post or message the same day is free. Match these to your X developer console if they differ.'
              )}
            </div>
            <div className="grid grid-cols-[auto_auto] mobile:grid-cols-1 gap-x-[16px] gap-y-[8px] items-center text-[14px] max-w-[560px]">
              {PRICE_LABELS.map(([key, tKey, label]) => (
                <React.Fragment key={key}>
                  <span>{t(tKey, label)}</span>
                  <Money step="0.001" value={prices[key]} onChange={(v) => setPrices((p) => ({ ...p, [key]: v }))} />
                </React.Fragment>
              ))}
            </div>
          </>
        )}
      </div>

      {error && <div className="text-[14px] text-red-400">{error}</div>}
      <div>
        <Button className={btn} onClick={save} loading={busy}>
          {t('save', 'Save')}
        </Button>
      </div>
    </div>
  );
};

export default XBudgetComponent;
