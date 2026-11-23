'use client';

// Bolt Advantage: a yellow "Drafts" button on the calendar, shown only when
// there are drafts. One click opens the list view on the Draft filter.
import React, { FC } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { expandPostsList } from '@gitroom/helpers/utils/posts.list.minify';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export const DraftsShortcut: FC<{ customer: string | null; active: boolean; onOpen: () => void }> = ({ customer, active, onOpen }) => {
  const fetch = useFetch();
  const t = useT();
  const params = new URLSearchParams({ page: '0', limit: '100', state: 'draft', customer: customer || '' }).toString();
  const { data } = useSWR(
    `bolt-drafts-count?${params}`,
    async () => expandPostsList(await (await fetch(`/posts/list?${params}`)).json()),
    { refreshInterval: 60000, revalidateOnFocus: true }
  );
  // a post for several channels is one draft
  const groups = new Set((data?.posts || []).map((p: any) => p.group || p.id));
  const count = groups.size;
  if (!count) return null;
  return (
    <div
      onClick={onOpen}
      title={t('open_drafts', 'Open your drafts')}
      className={clsx(
        'cursor-pointer h-[42px] px-[12px] rounded-[8px] border flex items-center gap-[8px] text-[14px] font-[600] select-none',
        active ? 'bg-amber-400 text-black border-amber-400' : 'border-amber-400 text-amber-400 hover:bg-amber-400/10'
      )}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M13.5 6.5l3 3" stroke="currentColor" strokeWidth="2" />
      </svg>
      {t('drafts_n', 'Drafts')}
      <span className={clsx('min-w-[20px] h-[20px] px-[5px] rounded-full text-[11px] flex items-center justify-center', active ? 'bg-black/20' : 'bg-amber-400 text-black')}>
        {data?.hasMore ? `${count}+` : count}
      </span>
    </div>
  );
};
