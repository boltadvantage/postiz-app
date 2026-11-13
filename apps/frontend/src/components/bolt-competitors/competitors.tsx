'use client';

// Bolt Advantage: competitors — accounts to watch per client, their follower
// growth next to ours, and their best recent posts for ideas.
import React, { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { ChannelAvatar } from '@gitroom/frontend/components/bolt-shared/channel.avatar';

type Growth = { start: number | null; end: number | null; change: number | null; percent: number | null };
type Post = { id: string; text: string; url: string | null; publishedAt: string; likes: number; reposts: number; replies: number };
type Competitor = {
  id: string;
  platform: 'x' | 'instagram' | 'nostr';
  handle: string;
  name: string | null;
  picture: string | null;
  customerId: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
  followers: number | null;
  growth: Growth;
  postsInWindow: number;
  topPosts: Post[];
};
type Ours = { id: string; name: string; picture: string | null; providerIdentifier: string; growth: Growth };

const PLATFORMS = [
  { value: 'x', label: 'X' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'nostr', label: 'Nostr' },
] as const;
const HINT: Record<string, string> = {
  x: '@handle — about $0.06 a day each from History’s X budget',
  instagram: 'username — Business or Creator accounts only, free',
  nostr: 'npub or name@domain — free',
};
const compact = (n: number | null) => (n === null ? '—' : Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n));
const signed = (n: number | null, suffix = '') => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toLocaleString()}${suffix}`);
const profileUrl = (c: Competitor) =>
  c.platform === 'x' ? `https://x.com/${c.handle}` : c.platform === 'instagram' ? `https://www.instagram.com/${c.handle}/` : `https://primal.net/p/${c.handle}`;

type SortKey = 'name' | 'followers' | 'change' | 'percent';
// no number sorts last whichever way the column is sorted
const sortValue = (r: { name: string; growth: Growth }, key: SortKey) =>
  key === 'name' ? r.name.toLowerCase() : key === 'followers' ? r.growth.end : key === 'change' ? r.growth.change : r.growth.percent;

const input = 'bg-newBgColorInner h-[36px] border-newTableBorder border rounded-[8px] px-[10px] text-[14px] text-textColor outline-none';

const CompetitorCard: FC<{ c: Competitor; isAdmin: boolean; refresh: () => void }> = ({ c, isAdmin, refresh }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const call = async (path: string, method: string) => {
    setBusy(true);
    const res = await fetch(path, { method });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toaster.show(body?.message || t('something_went_wrong', 'Something went wrong'), 'warning');
    }
    refresh();
  };
  return (
    <div className="rounded-[8px] bg-newTableHeader p-[14px] flex flex-col gap-[10px]">
      <div className="flex items-center gap-[12px]">
        <ChannelAvatar picture={c.picture} platform={c.platform} size={40} />
        <div className="min-w-0 flex-1">
          <a href={profileUrl(c)} target="_blank" rel="noreferrer" className="font-[500] hover:underline truncate block">
            {c.name || c.handle}
          </a>
          <div className="text-[12px] text-textItemBlur truncate">
            {c.platform === 'nostr' ? `${c.handle.slice(0, 16)}…` : `@${c.handle}`} ·{' '}
            {c.lastCheckAt ? t('checked_ago', 'checked {{when}}', { when: dayjs(c.lastCheckAt).fromNow() }) : t('not_checked', 'not checked yet')}
          </div>
        </div>
        <div className="text-end">
          <div className="text-[18px] font-[500] tabular-nums">{compact(c.followers)}</div>
          <div className={clsx('text-[12px] tabular-nums', (c.growth.change || 0) > 0 ? 'text-green-500' : (c.growth.change || 0) < 0 ? 'text-red-400' : 'text-textItemBlur')}>
            {signed(c.growth.change)} {c.growth.percent !== null ? `(${signed(c.growth.percent, '%')})` : ''}
          </div>
        </div>
      </div>
      {c.lastError && <div className="text-[12px] text-amber-400">{c.lastError}</div>}
      <div className="flex flex-wrap gap-[6px] text-[12px]">
        <button type="button" onClick={() => setOpen(!open)} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder">
          {open ? t('hide_posts', 'Hide posts') : t('top_posts_n', 'Top posts ({{n}})', { n: c.topPosts.length })}
        </button>
        {isAdmin && (
          <>
            <button type="button" disabled={busy} onClick={() => call(`/bolt-competitors/${c.id}/check`, 'POST')} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-50">
              {busy ? t('checking', 'Checking…') : t('check_now', 'Check now')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => window.confirm(t('remove_competitor_confirm', 'Stop tracking this account? Its saved history is kept.')) && call(`/bolt-competitors/${c.id}`, 'DELETE')}
              className="ms-auto px-[10px] h-[28px] rounded-[6px] hover:bg-newBgColorInner text-red-400"
            >
              {t('remove', 'Remove')}
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-[8px]">
          {!c.topPosts.length && <div className="text-[13px] text-textItemBlur">{t('no_posts_yet', 'No posts saved in this period yet.')}</div>}
          {c.topPosts.map((p) => (
            <div key={p.id} className="rounded-[6px] bg-newBgColorInner p-[10px] text-[13px] flex flex-col gap-[6px]">
              <div className="whitespace-pre-wrap break-words line-clamp-6">{p.text || t('no_text', '(no text)')}</div>
              <div className="flex flex-wrap gap-[10px] text-[12px] text-textItemBlur">
                <span>♥ {p.likes.toLocaleString()}</span>
                {c.platform !== 'instagram' && <span>⟲ {p.reposts.toLocaleString()}</span>}
                <span>💬 {p.replies.toLocaleString()}</span>
                <span>{dayjs(p.publishedAt).format('MMM D')}</span>
                {p.url && (
                  <a href={p.url} target="_blank" rel="noreferrer" className="ms-auto underline">
                    {t('open', 'Open')}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const Competitors = () => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const user = useUser();
  const isAdmin = !!user && user.role !== 'USER';
  const [client, setClient] = useState('');
  const [days, setDays] = useState(30);
  const [platform, setPlatform] = useState<string>('x');
  const [handle, setHandle] = useState('');
  const [forClient, setForClient] = useState('');
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'percent', dir: 'desc' });
  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  const { data: integrations } = useIntegrationList();
  const clients = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of (integrations || []) as any[]) if (c.customer?.id) seen.set(c.customer.id, c.customer.name);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [integrations]);

  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const { data, mutate, isLoading } = useSWR<{ competitors: Competitor[]; ours: Ours[] }>(
    `/bolt-competitors?days=${days}${client ? `&customerId=${client}` : ''}`,
    get
  );

  const add = async () => {
    setAdding(true);
    const res = await fetch('/bolt-competitors', { method: 'POST', body: JSON.stringify({ platform, handle, customerId: forClient || client || null }) });
    setAdding(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toaster.show(body?.message || t('could_not_add', 'Could not add'), 'warning');
    toaster.show(body?.lastError ? body.lastError : t('competitor_added', 'Added'), body?.lastError ? 'warning' : 'success');
    setHandle('');
    mutate();
  };

  const comparison = useMemo(() => {
    const rows = [
      ...(data?.ours || []).map((o) => ({ key: `o-${o.id}`, ours: true, name: o.name, picture: o.picture, platform: o.providerIdentifier, growth: o.growth })),
      ...(data?.competitors || []).map((c) => ({ key: `c-${c.id}`, ours: false, name: c.name || c.handle, picture: c.picture, platform: c.platform, growth: c.growth })),
    ];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * dir;
    });
  }, [data, sort]);
  const header = (key: SortKey, label: string, align: 'start' | 'end') => (
    <th className={clsx('font-normal pb-[6px]', align === 'end' ? 'text-end' : 'text-start')}>
      <button
        type="button"
        onClick={() => sortBy(key)}
        className={clsx('inline-flex items-center gap-[4px] hover:text-textColor', sort.key === key && 'text-textColor')}
        aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <span className={clsx('text-[10px]', sort.key !== key && 'opacity-0')}>{sort.dir === 'asc' ? '▲' : '▼'}</span>
      </button>
    </th>
  );

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[20px] overflow-y-auto">
      <div className="flex flex-wrap items-center gap-[12px]">
        <h2 className="text-[20px] font-[500] me-auto">{t('competitors', 'Competitors')}</h2>
        {!!clients.length && (
          <select value={client} onChange={(e) => setClient(e.target.value)} className={input}>
            <option value="">{t('all_clients', 'All clients')}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex rounded-[8px] border border-newTableBorder overflow-hidden text-[14px]">
          {[30, 90, 365].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={clsx('px-[12px] h-[34px]', days === d ? 'bg-[#612BD3] text-white' : 'hover:bg-newTableHeader')}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {isAdmin && (
        <div className="rounded-[8px] bg-newTableHeader p-[14px] flex flex-wrap items-end gap-[10px] text-[14px]">
          <label className="flex flex-col gap-[4px]">
            <span className="text-[12px] text-textItemBlur">{t('platform', 'Platform')}</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={input}>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-[4px] flex-1 min-w-[220px]">
            <span className="text-[12px] text-textItemBlur">{HINT[platform]}</span>
            <input value={handle} onChange={(e) => setHandle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handle.trim() && add()} className={input} placeholder={platform === 'nostr' ? 'npub1… or name@domain' : '@handle'} />
          </label>
          {!!clients.length && (
            <label className="flex flex-col gap-[4px]">
              <span className="text-[12px] text-textItemBlur">{t('for_client', 'For client')}</span>
              <select value={forClient || client} onChange={(e) => setForClient(e.target.value)} className={input}>
                <option value="">{t('everyone', 'Everyone')}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" disabled={adding || !handle.trim()} onClick={add} className="px-[16px] h-[36px] rounded-[8px] bg-[#612BD3] text-white disabled:opacity-40">
            {adding ? t('adding', 'Adding…') : t('add_competitor', 'Add competitor')}
          </button>
        </div>
      )}

      {isLoading && !data ? (
        <LoadingComponent />
      ) : !data?.competitors.length ? (
        <div className="text-[14px] text-textItemBlur">
          {t('competitors_empty', 'No competitors yet. Add an X, Instagram or Nostr account to start tracking its followers and posts. Facebook Pages and LinkedIn can’t be tracked: Meta and LinkedIn don’t allow reading other accounts.')}
        </div>
      ) : (
        <>
          <div className="rounded-[8px] bg-newTableHeader p-[14px] flex flex-col gap-[8px]">
            <div className="font-[500]">{t('growth_last_n_days', 'Follower growth, last {{n}} days', { n: days })}</div>
            <table className="w-full text-[14px]">
              <thead>
                <tr className="text-[12px] text-textItemBlur">
                  {header('name', t('account', 'Account'), 'start')}
                  {header('followers', t('followers', 'Followers'), 'end')}
                  {header('change', t('change', 'Change'), 'end')}
                  {header('percent', t('growth', 'Growth'), 'end')}
                </tr>
              </thead>
              <tbody>
                {comparison.map((r) => (
                  <tr key={r.key} className={clsx('border-t border-newTableBorder/60', r.ours && 'bg-[#612BD3]/10')}>
                    <td className="py-[6px]">
                      <span className="flex items-center gap-[8px]">
                        <ChannelAvatar picture={r.picture} platform={r.platform} size={22} />
                        <span className="truncate">{r.name}</span>
                        {r.ours && <span className="rounded-full bg-[#612BD3] text-white px-[6px] text-[10px]">{t('yours', 'yours')}</span>}
                      </span>
                    </td>
                    <td className="py-[6px] text-end tabular-nums">{compact(r.growth.end)}</td>
                    <td className="py-[6px] text-end tabular-nums">{signed(r.growth.change)}</td>
                    <td className="py-[6px] text-end tabular-nums">{signed(r.growth.percent, '%')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[12px] text-textItemBlur">
              {t('growth_note', 'From the first to the latest saved count in the period. Competitors start counting the day they’re added.')}
            </div>
          </div>
          <div className="grid grid-cols-2 mobile:grid-cols-1 gap-[12px]">
            {data.competitors.map((c) => (
              <CompetitorCard key={c.id} c={c} isAdmin={isAdmin} refresh={() => mutate()} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
