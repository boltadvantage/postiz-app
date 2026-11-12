'use client';

// Bolt Advantage: the inbox's Follows tab — who followed each X and Nostr
// channel (and who unfollowed on Nostr), filtered per channel in its settings.
import React, { FC, useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { Channel, Person, PersonPanel, SelectionBar, Status } from '@gitroom/frontend/components/bolt-inbox/shared';

type Follow = {
  id: string;
  integrationId: string;
  platform: string;
  authorId: string;
  event: 'follow' | 'unfollow';
  followers: number | null;
  verified: boolean;
  at: string;
  readAt: string | null;
  archivedAt: string | null;
  followedBackAt: string | null;
  person: Person | null;
};

const compact = (n: number) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const profileUrl = (f: Follow) =>
  f.platform === 'x' ? (f.person?.handle ? `https://x.com/${f.person.handle}` : `https://x.com/i/user/${f.authorId}`) : `https://primal.net/p/${f.authorId}`;

const FollowRow: FC<{ f: Follow; channel?: Channel; allTags: string[]; selected: boolean; onSelect: (on: boolean) => void; refresh: () => void }> = ({
  f,
  channel,
  allTags,
  selected,
  onSelect,
  refresh,
}) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [busy, setBusy] = useState(false);
  const [person, setPerson] = useState(false);
  const p = f.person;

  const followBack = async () => {
    setBusy(true);
    const res = await fetch(`/inbox/follows/${f.id}/follow-back`, { method: 'POST' });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toaster.show(body?.message || t('could_not_follow', 'Could not follow'), 'warning');
    }
    toaster.show(t('followed_back', 'Followed back'), 'success');
    refresh();
  };
  const mark = async (action: 'read' | 'archive' | 'unarchive') => {
    await fetch('/inbox/follows/mark', { method: 'POST', body: JSON.stringify({ ids: [f.id], action }) });
    refresh();
  };

  return (
    <div className={clsx('rounded-[8px] p-[12px] border', selected ? 'border-[#612BD3]' : f.readAt ? 'border-transparent' : 'border-[#612BD3]/50', f.readAt ? 'bg-newTableHeader/50' : 'bg-newTableHeader')}>
      <div className="flex gap-[10px] items-start">
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="mt-[10px] shrink-0 cursor-pointer" aria-label={t('select', 'Select')} />
        <div className="relative shrink-0 w-[36px] h-[36px]">
          <img src={p?.avatar || `/icons/platforms/${f.platform}.png`} className="w-[36px] h-[36px] rounded-full object-cover" alt="" />
          <img src={`/icons/platforms/${f.platform}.png`} className="w-[18px] h-[18px] rounded-[6px] absolute -bottom-[3px] -end-[5px] border border-fifth" alt={f.platform} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[13px]">
            <a href={profileUrl(f)} target="_blank" rel="noreferrer" className="font-[500] hover:underline truncate max-w-[220px]">
              {p?.name || p?.handle || `${f.authorId.slice(0, 10)}…`}
            </a>
            {f.verified && <span title={t('verified', 'Verified')} className="text-[#1d9bf0]">✔</span>}
            {p?.handle && f.platform === 'x' && <span className="text-textItemBlur truncate max-w-[160px]">@{p.handle}</span>}
            {f.followers !== null && <span className="text-textItemBlur">{t('n_followers', '{{n}} followers', { n: compact(f.followers) })}</span>}
            {p?.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-[#612BD3]/30 px-[8px] h-[20px] text-[11px] flex items-center">{tag}</span>
            ))}
            <span className="ms-auto text-[12px] text-textItemBlur whitespace-nowrap">
              {f.event === 'follow' ? t('followed', 'Followed') : t('unfollowed', 'Unfollowed')} {channel?.name || ''} · {dayjs(f.at).fromNow()}
            </span>
          </div>
          <div className="mt-[8px] flex flex-wrap items-center gap-[6px] text-[12px]">
            {f.event === 'follow' && (
              <button type="button" disabled={busy || !!f.followedBackAt} onClick={followBack} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-50">
                {f.followedBackAt ? t('following', 'Following') + ' ✓' : busy ? t('following_dots', 'Following…') : t('follow_back', 'Follow back')}
              </button>
            )}
            <a href={profileUrl(f)} target="_blank" rel="noreferrer" className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder flex items-center">
              {t('open', 'Open')}
            </a>
            <span className="ms-auto flex gap-[6px]">
              {!f.readAt && (
                <button type="button" onClick={() => mark('read')} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newBgColorInner">
                  {t('mark_read', 'Mark read')}
                </button>
              )}
              <button type="button" onClick={() => mark(f.archivedAt ? 'unarchive' : 'archive')} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newBgColorInner">
                {f.archivedAt ? t('unarchive', 'Unarchive') : t('archive', 'Archive')}
              </button>
              {p && (
                <button type="button" onClick={() => setPerson(!person)} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newBgColorInner">
                  {t('tag_or_mute', 'Tag / mute')}
                </button>
              )}
            </span>
          </div>
          {person && p && <PersonPanel person={p} allTags={allTags} onSaved={refresh} onClose={() => setPerson(false)} />}
        </div>
      </div>
    </div>
  );
};

export const Follows: FC<{
  status: Status;
  channels: string[];
  tag: string;
  showMuted: boolean;
  search: string;
  channelById: Map<string, Channel>;
  allTags: string[];
  onChanged: () => void;
}> = ({ status, channels, tag, showMuted, search, channelById, allTags, onChanged }) => {
  const t = useT();
  const fetch = useFetch();
  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams({
    status,
    page: String(page),
    ...(channels.length ? { channels: channels.join(',') } : {}),
    ...(tag ? { tag } : {}),
    ...(showMuted ? { showMuted: 'true' } : {}),
    ...(search ? { q: search } : {}),
  }).toString();
  const { data, mutate, isLoading } = useSWR<{ total: number; pages: number; items: Follow[]; off: boolean }>(`/inbox/follows?${query}`, get, { refreshInterval: 60000 });
  useEffect(() => setPage(0), [status, channels.join(','), tag, showMuted, search]);
  useEffect(() => setSelected([]), [query]);
  const refresh = () => {
    mutate();
    onChanged();
  };
  const bulk = async (action: 'read' | 'archive' | 'unarchive' | 'delete') => {
    if (!selected.length) return;
    setBusy(true);
    await fetch(action === 'delete' ? '/inbox/follows/delete' : '/inbox/follows/mark', { method: 'POST', body: JSON.stringify({ ids: selected, action }) });
    setBusy(false);
    if (action !== 'read') setSelected([]);
    refresh();
  };

  if (isLoading && !data) return <LoadingComponent />;
  if (data?.off) {
    return (
      <div className="text-[14px] text-textItemBlur py-[24px] text-center">
        {t('follows_off', 'Follows are off for every channel. Turn them on under Channels → Turn channels on or off.')}
      </div>
    );
  }
  if (!data?.items.length) {
    return (
      <div className="text-[14px] text-textItemBlur py-[24px] text-center">
        {search || tag || channels.length ? t('inbox_nothing_matches', 'Nothing matches these filters.') : t('follows_empty', 'No new followers yet. They show up within about an hour.')}
      </div>
    );
  }
  return (
    <>
      <SelectionBar
        count={selected.length}
        pageCount={data.items.length}
        archived={status === 'archived'}
        busy={busy}
        onAll={(on) => setSelected(on ? data.items.map((f) => f.id) : [])}
        onAction={bulk}
      />
      {data.items.map((f) => (
        <FollowRow
          key={f.id}
          f={f}
          channel={channelById.get(f.integrationId)}
          allTags={allTags}
          selected={selected.includes(f.id)}
          onSelect={(on) => setSelected((s) => (on ? [...s, f.id] : s.filter((x) => x !== f.id)))}
          refresh={refresh}
        />
      ))}
      {data.pages > 1 && (
        <div className="flex gap-[8px] justify-end text-[13px]">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40">{t('previous', 'Previous')}</button>
          <span className="self-center text-textItemBlur">{page + 1} / {data.pages}</span>
          <button type="button" disabled={page >= data.pages - 1} onClick={() => setPage(page + 1)} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40">{t('next', 'Next')}</button>
        </div>
      )}
    </>
  );
};
