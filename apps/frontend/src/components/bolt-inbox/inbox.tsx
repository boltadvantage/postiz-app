'use client';

// Bolt Advantage: inbox — mentions, replies and quotes across channels, with
// private tags and mutes per person, and reply / quote / repost in place,
// plus direct messages (see messages.tsx).
import React, { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { Channel, Person, PersonPanel, pretty, Status } from '@gitroom/frontend/components/bolt-inbox/shared';
import { Messages } from '@gitroom/frontend/components/bolt-inbox/messages';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
dayjs.extend(relativeTime);

type Item = {
  id: string;
  integrationId: string;
  platform: string;
  kind: 'mention' | 'reply' | 'quote';
  content: string;
  url: string | null;
  inReplyToText: string | null;
  publishedAt: string;
  readAt: string | null;
  archivedAt: string | null;
  repliedAt: string | null;
  repostedAt: string | null;
  quotedAt: string | null;
  person: Person | null;
};

const KINDS: Array<{ value: Item['kind']; label: string }> = [
  { value: 'mention', label: 'Mentions' },
  { value: 'reply', label: 'Replies' },
  { value: 'quote', label: 'Quotes' },
];
const LIMITS: Record<string, number> = { x: 280 };
const short = (s: string | null, n = 140) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const Composer: FC<{ mode: 'reply' | 'quote'; platform: string; busy: boolean; onSend: (text: string) => void; onCancel: () => void }> = ({
  mode,
  platform,
  busy,
  onSend,
  onCancel,
}) => {
  const t = useT();
  const [text, setText] = useState('');
  const limit = LIMITS[platform];
  const over = !!limit && text.length > limit;
  return (
    <div className="flex flex-col gap-[6px] mt-[8px]">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={mode === 'reply' ? t('write_reply', 'Write a reply…') : t('add_comment_quote', 'Add your comment…')}
        className="bg-newBgColorInner border border-newTableBorder rounded-[8px] p-[10px] text-[14px] outline-none resize-y"
      />
      <div className="flex items-center gap-[8px] text-[12px]">
        {limit && <span className={clsx(over ? 'text-red-400' : 'text-textItemBlur')}>{text.length}/{limit}</span>}
        <button type="button" onClick={onCancel} className="ms-auto px-[12px] h-[30px] rounded-[6px] border border-newTableBorder">
          {t('cancel', 'Cancel')}
        </button>
        <button
          type="button"
          disabled={busy || !text.trim() || over}
          onClick={() => onSend(text)}
          className="px-[14px] h-[30px] rounded-[6px] bg-[#612BD3] text-white disabled:opacity-40"
        >
          {busy ? t('sending', 'Sending…') : mode === 'reply' ? t('send_reply', 'Reply') : t('send_quote', 'Quote')}
        </button>
      </div>
    </div>
  );
};

const Row: FC<{ item: Item; channel?: Channel; allTags: string[]; refresh: () => void }> = ({ item, channel, allTags, refresh }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [open, setOpen] = useState<null | 'reply' | 'quote' | 'person'>(null);
  const [busy, setBusy] = useState(false);
  const p = item.person;

  const act = async (action: 'reply' | 'quote' | 'repost', text?: string) => {
    setBusy(true);
    const res = await fetch(`/inbox/${item.id}/${action}`, { method: 'POST', body: JSON.stringify({ text }) });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toaster.show(body?.message || t('could_not_send', 'Could not send'), 'warning');
    }
    toaster.show(action === 'reply' ? t('reply_sent', 'Reply sent') : action === 'quote' ? t('quote_sent', 'Quote posted') : t('reposted', 'Reposted'), 'success');
    setOpen(null);
    refresh();
  };
  const mark = async (action: 'read' | 'unread' | 'archive' | 'unarchive') => {
    await fetch('/inbox/mark', { method: 'POST', body: JSON.stringify({ ids: [item.id], action }) });
    refresh();
  };

  return (
    <div className={clsx('rounded-[8px] p-[12px] border', item.readAt ? 'bg-newTableHeader/50 border-transparent' : 'bg-newTableHeader border-[#612BD3]/50')}>
      <div className="flex gap-[10px]">
        <img src={p?.avatar || `/icons/platforms/${item.platform}.png`} className="w-[36px] h-[36px] rounded-full shrink-0 object-cover" alt="" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[13px]">
            <button type="button" onClick={() => setOpen(open === 'person' ? null : 'person')} className="font-[500] hover:underline truncate max-w-[220px]">
              {p?.name || p?.handle || t('unknown', 'Unknown')}
            </button>
            {p?.handle && <span className="text-textItemBlur truncate max-w-[160px]">@{p.handle}</span>}
            {p?.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-[#612BD3]/30 px-[8px] h-[20px] text-[11px] flex items-center">{tag}</span>
            ))}
            {p?.muted && <span className="rounded-full bg-red-900/50 px-[8px] h-[20px] text-[11px] flex items-center">{t('muted', 'muted')}</span>}
            <span className="ms-auto flex items-center gap-[6px] text-[12px] text-textItemBlur whitespace-nowrap">
              <img src={channel?.picture || `/icons/platforms/${item.platform}.png`} className="w-[16px] h-[16px] rounded-full" alt="" />
              {item.kind === 'reply' ? t('reply', 'Reply') : item.kind === 'quote' ? t('quote', 'Quote') : t('mention', 'Mention')} · {dayjs(item.publishedAt).fromNow()}
            </span>
          </div>
          {item.inReplyToText && (
            <div className="mt-[4px] text-[12px] text-textItemBlur border-s-2 border-newTableBorder ps-[8px]">
              {item.kind === 'quote' ? t('quoted_your_post', 'Quoted your post:') : t('replying_to_you', 'Replying to your post:')} {short(item.platform === 'nostr' ? pretty(item.inReplyToText || '') : item.inReplyToText)}
            </div>
          )}
          <div className="mt-[6px] text-[14px] whitespace-pre-wrap break-words">{item.platform === 'nostr' ? pretty(item.content) : item.content}</div>
          <div className="mt-[8px] flex flex-wrap items-center gap-[6px] text-[12px]">
            <button type="button" onClick={() => setOpen(open === 'reply' ? null : 'reply')} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder">
              {t('reply', 'Reply')}{item.repliedAt ? ' ✓' : ''}
            </button>
            <button type="button" onClick={() => setOpen(open === 'quote' ? null : 'quote')} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder">
              {t('quote', 'Quote')}{item.quotedAt ? ' ✓' : ''}
            </button>
            <button type="button" disabled={busy || !!item.repostedAt} onClick={() => act('repost')} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-50">
              {item.repostedAt ? t('reposted', 'Reposted') : t('repost', 'Repost')}
            </button>
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer" className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder flex items-center">
                {t('open', 'Open')}
              </a>
            )}
            <span className="ms-auto flex gap-[6px]">
              <button type="button" onClick={() => mark(item.readAt ? 'unread' : 'read')} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newBgColorInner">
                {item.readAt ? t('mark_unread', 'Mark unread') : t('mark_read', 'Mark read')}
              </button>
              <button type="button" onClick={() => mark(item.archivedAt ? 'unarchive' : 'archive')} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newBgColorInner">
                {item.archivedAt ? t('unarchive', 'Unarchive') : t('archive', 'Archive')}
              </button>
              {p && (
                <button type="button" onClick={() => setOpen(open === 'person' ? null : 'person')} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newBgColorInner">
                  {t('tag_or_mute', 'Tag / mute')}
                </button>
              )}
            </span>
          </div>
          {(open === 'reply' || open === 'quote') && (
            <Composer key={open} mode={open} platform={item.platform} busy={busy} onSend={(text) => act(open, text)} onCancel={() => setOpen(null)} />
          )}
          {open === 'person' && p && <PersonPanel person={p} allTags={allTags} onSaved={refresh} onClose={() => setOpen(null)} />}
        </div>
      </div>
    </div>
  );
};

export const Inbox = () => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [view, setView] = useState<'mentions' | 'messages'>('mentions');
  const [status, setStatus] = useState<Status>('open');
  const [channels, setChannels] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [tag, setTag] = useState('');
  const [showMuted, setShowMuted] = useState(false);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const query = new URLSearchParams({
    status,
    page: String(page),
    ...(channels.length ? { channels: channels.join(',') } : {}),
    ...(kinds.length ? { kinds: kinds.join(',') } : {}),
    ...(tag ? { tag } : {}),
    ...(showMuted ? { showMuted: 'true' } : {}),
    ...(search ? { q: search } : {}),
  }).toString();
  const { data, mutate, isLoading } = useSWR<{ total: number; pages: number; items: Item[] }>(view === 'mentions' ? `/inbox?${query}` : null, get, { refreshInterval: 60000 });
  const { data: counts, mutate: mutateCounts } = useSWR<{ unread: number; byChannel: Record<string, number>; messages: number }>('/inbox/counts', get, { refreshInterval: 60000 });
  const { data: tags, mutate: mutateTags } = useSWR<Array<{ tag: string; people: number }>>('/inbox/tags', get);
  const { data: muted, mutate: mutateMuted } = useSWR<Person[]>('/inbox/people?muted=true', get);
  // the app's shared channel list (other screens cache this key as a plain array)
  const { data: integrations } = useIntegrationList();
  const channelList = useMemo(
    () => ((integrations || []) as Channel[]).filter((c) => ['nostr', 'x'].includes(c.identifier)),
    [integrations]
  );
  const channelById = useMemo(() => new Map(channelList.map((c) => [c.id, c])), [channelList]);
  const refresh = useCallback(() => {
    mutate();
    mutateCounts();
    mutateTags();
    mutateMuted();
  }, []);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
    setPage(0);
  };

  const syncNow = async () => {
    const r = await (await fetch('/inbox/sync', { method: 'POST' })).json();
    toaster.show(r.started ? t('checking_inbox', 'Checking for new mentions and messages…') : t('sync_running', 'A check is already running.'), 'success');
    setTimeout(refresh, 8000);
  };
  const markAllRead = async () => {
    const ids = (data?.items || []).filter((i) => !i.readAt).map((i) => i.id);
    if (!ids.length) return;
    await fetch('/inbox/mark', { method: 'POST', body: JSON.stringify({ ids, action: 'read' }) });
    refresh();
  };
  const unmute = async (p: Person) => {
    await fetch(`/inbox/people/${p.id}`, { method: 'PUT', body: JSON.stringify({ muted: false }) });
    refresh();
  };

  const side = 'flex flex-col gap-[4px] text-[13px]';
  const pill = (active: boolean) => clsx('text-start px-[10px] h-[30px] rounded-[6px] flex items-center gap-[8px]', active ? 'bg-[#612BD3] text-white' : 'hover:bg-newTableHeader');

  return (
    <div className="bg-newBgColorInner flex flex-1 min-h-0 mobile:flex-col">
      <div className="w-[230px] mobile:w-full shrink-0 p-[16px] flex flex-col gap-[18px] border-e border-newTableBorder overflow-y-auto">
        <div className="grid grid-cols-2 gap-[4px] p-[3px] rounded-[8px] bg-newTableHeader text-[13px]">
          {(['mentions', 'messages'] as const).map((v) => {
            const n = v === 'mentions' ? counts?.unread : counts?.messages;
            return (
              <button key={v} type="button" onClick={() => (setView(v), setPage(0))} className={clsx('h-[30px] rounded-[6px] flex items-center justify-center gap-[6px]', view === v ? 'bg-[#612BD3] text-white' : 'hover:bg-newBgColorInner')}>
                {v === 'mentions' ? t('mentions', 'Mentions') : t('messages', 'Messages')}
                {!!n && <span className="min-w-[16px] h-[16px] px-[4px] rounded-full bg-red-500 text-white text-[10px] font-[600] flex items-center justify-center">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className={side}>
          {(['open', 'unread', 'archived', 'all'] as Status[]).map((s) => (
            <button key={s} type="button" onClick={() => (setStatus(s), setPage(0))} className={pill(status === s)}>
              {s === 'open' ? t('inbox', 'Inbox') : s === 'unread' ? t('unread', 'Unread') : s === 'archived' ? t('archived', 'Archived') : t('all', 'All')}
              {s === 'unread' && view === 'mentions' && !!counts?.unread && <span className="ms-auto text-[11px]">{counts.unread}</span>}
              {s === 'unread' && view === 'messages' && !!counts?.messages && <span className="ms-auto text-[11px]">{counts.messages}</span>}
            </button>
          ))}
        </div>
        <div className={side}>
          <div className="text-[11px] uppercase text-textItemBlur tracking-wide">{t('channels', 'Channels')}</div>
          {channelList.map((c) => (
            <button key={c.id} type="button" onClick={() => toggle(channels, setChannels, c.id)} className={pill(channels.includes(c.id))}>
              <img src={c.picture || `/icons/platforms/${c.identifier}.png`} className="w-[18px] h-[18px] rounded-full" alt="" />
              <span className="truncate">{c.name}</span>
              {view === 'mentions' && !!counts?.byChannel[c.id] && <span className="ms-auto text-[11px]">{counts.byChannel[c.id]}</span>}
            </button>
          ))}
          {!channelList.length && <div className="text-[12px] text-textItemBlur">{t('inbox_no_channels', 'Connect X or Nostr to use the inbox.')}</div>}
        </div>
        <div className={clsx(side, view === 'messages' && 'hidden')}>
          <div className="text-[11px] uppercase text-textItemBlur tracking-wide">{t('type', 'Type')}</div>
          {KINDS.map((k) => (
            <button key={k.value} type="button" onClick={() => toggle(kinds, setKinds, k.value)} className={pill(kinds.includes(k.value))}>
              {t(`inbox_kind_${k.value}`, k.label)}
            </button>
          ))}
        </div>
        <div className={side}>
          <div className="text-[11px] uppercase text-textItemBlur tracking-wide">{t('tags', 'Tags')}</div>
          {(tags || []).map((x) => (
            <button key={x.tag} type="button" onClick={() => (setTag(tag === x.tag ? '' : x.tag), setPage(0))} className={pill(tag === x.tag)}>
              <span className="truncate">{x.tag}</span>
              <span className="ms-auto text-[11px]">{x.people}</span>
            </button>
          ))}
          {!tags?.length && <div className="text-[12px] text-textItemBlur">{t('no_tags_yet', 'Tag people from any post to filter by them here.')}</div>}
        </div>
        <div className={side}>
          <label className="flex items-center gap-[8px] cursor-pointer px-[2px]">
            <input type="checkbox" checked={showMuted} onChange={(e) => (setShowMuted(e.target.checked), setPage(0))} />
            {t('show_muted', 'Show muted people')}
          </label>
          {!!muted?.length && (
            <details className="text-[12px] text-textItemBlur">
              <summary className="cursor-pointer">{t('muted_count', '{{n}} muted', { n: muted.length })}</summary>
              <div className="flex flex-col gap-[4px] mt-[6px]">
                {muted.map((m) => (
                  <div key={m.id} className="flex items-center gap-[6px]">
                    <span className="truncate">{m.name || m.handle || m.authorId.slice(0, 10)}</span>
                    <button type="button" onClick={() => unmute(m)} className="ms-auto underline">{t('unmute', 'Unmute')}</button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 p-[16px] flex flex-col gap-[12px] overflow-y-auto">
        <div className="flex flex-wrap items-center gap-[10px]">
          <h2 className="text-[20px] font-[500] me-auto">{view === 'messages' ? t('messages', 'Messages') : t('inbox', 'Inbox')}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
              setPage(0);
            }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={view === 'messages' ? t('search_messages', 'Search people or messages…') : t('search_inbox', 'Search…')}
              className="bg-newTableHeader border border-newTableBorder rounded-[8px] h-[34px] px-[12px] text-[13px] outline-none w-[220px]"
            />
          </form>
          <button type="button" onClick={markAllRead} className={clsx('px-[12px] h-[34px] rounded-[8px] border border-newTableBorder text-[13px] whitespace-nowrap', view === 'messages' && 'hidden')}>
            {t('mark_page_read', 'Mark all read')}
          </button>
          <button type="button" onClick={syncNow} className="px-[12px] h-[34px] rounded-[8px] bg-[#612BD3] text-white text-[13px] whitespace-nowrap">
            {t('check_now', 'Check now')}
          </button>
        </div>
        {view === 'messages' ? (
          <Messages
            status={status}
            channels={channels}
            tag={tag}
            showMuted={showMuted}
            search={search}
            channelById={channelById}
            allTags={(tags || []).map((x) => x.tag)}
            onChanged={refresh}
          />
        ) : isLoading && !data ? (
          <LoadingComponent />
        ) : !data?.items.length ? (
          <div className="text-[14px] text-textItemBlur py-[24px] text-center">
            {search || tag || kinds.length || channels.length ? t('inbox_nothing_matches', 'Nothing matches these filters.') : t('inbox_empty', 'Nothing here yet. New mentions show up within about 10 minutes.')}
          </div>
        ) : (
          data.items.map((item) => <Row key={item.id} item={item} channel={channelById.get(item.integrationId)} allTags={(tags || []).map((x) => x.tag)} refresh={refresh} />)
        )}
        {view === 'mentions' && !!data && data.pages > 1 && (
          <div className="flex gap-[8px] justify-end text-[13px]">
            <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40">{t('previous', 'Previous')}</button>
            <span className="self-center text-textItemBlur">{page + 1} / {data.pages}</span>
            <button type="button" disabled={page >= data.pages - 1} onClick={() => setPage(page + 1)} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40">{t('next', 'Next')}</button>
          </div>
        )}
      </div>
    </div>
  );
};
