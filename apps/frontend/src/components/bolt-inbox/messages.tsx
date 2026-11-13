'use client';

// Bolt Advantage: direct messages — one-to-one conversations on Nostr and X,
// sharing the inbox's people, tags and mutes.
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { Channel as InboxChannel, Person as InboxPerson, PersonPanel, pretty, ProblemNote, SelectionBar, Status as InboxStatus } from '@gitroom/frontend/components/bolt-inbox/shared';
import { ChannelAvatar } from '@gitroom/frontend/components/bolt-shared/channel.avatar';

type Conversation = {
  id: string;
  integrationId: string;
  platform: string;
  peerId: string;
  protocol: string | null;
  lastMessageAt: string;
  lastPreview: string | null;
  lastDirection: string | null;
  unread: number;
  archivedAt: string | null;
  person: InboxPerson | null;
};
type Message = { id: string; direction: 'in' | 'out'; content: string; sentAt: string; protocol: string | null };

const when = (d: string) => {
  const x = dayjs(d);
  return x.isSame(dayjs(), 'day') ? x.format('h:mm A') : x.isSame(dayjs(), 'year') ? x.format('MMM D') : x.format('MMM D, YYYY');
};
const who = (c: Conversation) => c.person?.name || c.person?.handle || `${c.peerId.slice(0, 10)}…`;

/** Meta lets a Page answer only within 24 hours of the person's last message. */
const ReplyWindow: FC<{ messages?: Message[] }> = ({ messages }) => {
  const t = useT();
  const lastIn = [...(messages || [])].reverse().find((m) => m.direction === 'in');
  if (!lastIn) return null;
  const left = dayjs(lastIn.sentAt).add(24, 'hour').diff(dayjs(), 'minute');
  return (
    <span title={t('reply_window_explain', 'Facebook and Instagram only let you reply within 24 hours of their last message.')} className={clsx(left <= 0 && 'text-red-400')}>
      ·{' '}
      {left <= 0
        ? t('reply_window_closed', 'reply window closed')
        : left < 60
        ? t('reply_window_minutes', '{{n}} min left to reply', { n: left })
        : t('reply_window_hours', '{{n}} h left to reply', { n: Math.floor(left / 60) })}
    </span>
  );
};

const Thread: FC<{ convo: Conversation; channel?: InboxChannel; allTags: string[]; onChanged: () => void }> = ({ convo, channel, allTags, onChanged }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const { data, mutate } = useSWR<{ messages: Message[]; more: boolean }>(`/inbox/dm/${convo.id}`, get, { refreshInterval: 30000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [person, setPerson] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  // opening a conversation marks it read on the server; refresh the list and badge
  useEffect(() => {
    if (data && convo.unread) onChanged();
  }, [!!data]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages.length]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const res = await fetch(`/inbox/dm/${convo.id}/send`, { method: 'POST', body: JSON.stringify({ text }) });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toaster.show(body?.message || t('could_not_send', 'Could not send'), 'warning');
    }
    setText('');
    mutate();
    onChanged();
  };
  const archive = async () => {
    await fetch('/inbox/dm/mark', { method: 'POST', body: JSON.stringify({ ids: [convo.id], action: convo.archivedAt ? 'unarchive' : 'archive' }) });
    onChanged();
  };
  const markUnread = async () => {
    await fetch('/inbox/dm/mark', { method: 'POST', body: JSON.stringify({ ids: [convo.id], action: 'unread' }) });
    onChanged();
  };

  const p = convo.person;
  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-[8px] p-[12px] border-b border-newTableBorder text-[13px]">
        <img src={p?.avatar || `/icons/platforms/${convo.platform}.png`} className="w-[32px] h-[32px] rounded-full object-cover" alt="" />
        <div className="min-w-0">
          <button type="button" onClick={() => setPerson(!person)} className="font-[500] hover:underline truncate block max-w-[260px] text-start">
            {who(convo)}
          </button>
          <div className="flex items-center gap-[6px] text-[11px] text-textItemBlur">
            {p?.handle && <span className="truncate max-w-[160px]">@{p.handle}</span>}
            <ChannelAvatar picture={channel?.picture} platform={convo.platform} size={18} />
            <span className="truncate max-w-[140px]">{channel?.name}</span>
            {(convo.platform === 'facebook' || convo.platform === 'instagram') && <ReplyWindow messages={data?.messages} />}
            {convo.platform === 'nostr' && (
              <span title={convo.protocol === 'nip04' ? t('dm_nip04_explain', 'They use the older Nostr encryption (NIP-04), so replies use it too.') : t('dm_nip17_explain', 'Private messages (NIP-17): content and who you talk to are hidden from relays.')}>
                · {convo.protocol === 'nip04' ? t('dm_nip04', 'older encryption') : t('dm_nip17', 'private')}
              </span>
            )}
          </div>
        </div>
        {p?.tags.map((tag) => (
          <span key={tag} className="rounded-full bg-[#612BD3]/30 px-[8px] h-[20px] text-[11px] flex items-center">{tag}</span>
        ))}
        <span className="ms-auto flex gap-[6px] text-[12px]">
          <button type="button" onClick={markUnread} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newTableHeader">{t('mark_unread', 'Mark unread')}</button>
          <button type="button" onClick={archive} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newTableHeader">
            {convo.archivedAt ? t('unarchive', 'Unarchive') : t('archive', 'Archive')}
          </button>
          {p && (
            <button type="button" onClick={() => setPerson(!person)} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newTableHeader">{t('tag_or_mute', 'Tag / mute')}</button>
          )}
        </span>
        {person && p && (
          <div className="w-full">
            <PersonPanel person={p} allTags={allTags} onSaved={onChanged} onClose={() => setPerson(false)} />
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-[12px] flex flex-col gap-[6px]">
        {!data ? (
          <LoadingComponent />
        ) : (
          data.messages.map((m, i) => {
            const prev = data.messages[i - 1];
            const showDay = !prev || !dayjs(prev.sentAt).isSame(m.sentAt, 'day');
            return (
              <React.Fragment key={m.id}>
                {showDay && <div className="text-center text-[11px] text-textItemBlur my-[6px]">{dayjs(m.sentAt).format('ddd, MMM D')}</div>}
                <div className={clsx('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={clsx(
                      'max-w-[75%] rounded-[12px] px-[12px] py-[8px] text-[14px] whitespace-pre-wrap break-words',
                      m.direction === 'out' ? 'bg-[#612BD3] text-white rounded-ee-[4px]' : 'bg-newTableHeader rounded-es-[4px]'
                    )}
                  >
                    {convo.platform === 'nostr' ? pretty(m.content) : m.content}
                    <div className={clsx('text-[10px] mt-[2px] text-end', m.direction === 'out' ? 'text-white/70' : 'text-textItemBlur')}>{dayjs(m.sentAt).format('h:mm A')}</div>
                  </div>
                </div>
              </React.Fragment>
            );
          })
        )}
        <div ref={end} />
      </div>
      <div className="p-[12px] border-t border-newTableBorder flex gap-[8px] items-end">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={t('write_message', 'Write a message… (Enter sends, Shift+Enter for a new line)')}
          className="flex-1 bg-newTableHeader border border-newTableBorder rounded-[8px] p-[10px] text-[14px] outline-none resize-y"
        />
        <button type="button" disabled={busy || !text.trim()} onClick={send} className="px-[16px] h-[38px] rounded-[8px] bg-[#612BD3] text-white text-[13px] disabled:opacity-40">
          {busy ? t('sending', 'Sending…') : t('send', 'Send')}
        </button>
      </div>
    </div>
  );
};

export const Messages: FC<{
  status: InboxStatus;
  channels: string[];
  tag: string;
  showMuted: boolean;
  search: string;
  channelById: Map<string, InboxChannel>;
  allTags: string[];
  onChanged: () => void;
}> = ({ status, channels, tag, showMuted, search, channelById, allTags, onChanged }) => {
  const t = useT();
  const fetch = useFetch();
  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const query = new URLSearchParams({
    status,
    page: String(page),
    ...(channels.length ? { channels: channels.join(',') } : {}),
    ...(tag ? { tag } : {}),
    ...(showMuted ? { showMuted: 'true' } : {}),
    ...(search ? { q: search } : {}),
  }).toString();
  const { data, mutate, isLoading } = useSWR<{ total: number; pages: number; conversations: Conversation[] }>(`/inbox/dm?${query}`, get, { refreshInterval: 30000 });
  const { data: problems } = useSWR<Record<string, string>>('/inbox/dm/problems', get, { refreshInterval: 300000 });
  useEffect(() => setPage(0), [status, channels.join(','), tag, showMuted, search]);
  useEffect(() => setSelected([]), [query]);
  const changed = () => {
    mutate();
    onChanged();
  };
  const open = data?.conversations.find((c) => c.id === openId) || null;
  const bulk = async (action: 'read' | 'archive' | 'unarchive' | 'delete') => {
    if (!selected.length) return;
    setBulkBusy(true);
    await fetch(action === 'delete' ? '/inbox/dm/delete' : '/inbox/dm/mark', { method: 'POST', body: JSON.stringify({ ids: selected, action }) });
    setBulkBusy(false);
    if (action !== 'read') {
      if (openId && selected.includes(openId)) setOpenId(null);
      setSelected([]);
    }
    changed();
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-[10px]">
      {Object.entries(problems || {}).map(([id, msg]) => (
        <ProblemNote key={id} channel={channelById.get(id)} message={msg} />
      ))}
      <div className="flex flex-1 min-h-0 rounded-[8px] border border-newTableBorder overflow-hidden mobile:flex-col">
        <div className={clsx('w-[320px] mobile:w-full shrink-0 border-e border-newTableBorder overflow-y-auto', open && 'mobile:hidden')}>
          {isLoading && !data ? (
            <LoadingComponent />
          ) : !data?.conversations.length ? (
            <div className="text-[13px] text-textItemBlur p-[16px] text-center">
              {search || tag || channels.length ? t('inbox_nothing_matches', 'Nothing matches these filters.') : t('dm_empty', 'No messages yet. New ones show up within about 10 minutes.')}
            </div>
          ) : (
            <>
              <div className="p-[6px] border-b border-newTableBorder/60">
                <SelectionBar
                  count={selected.length}
                  pageCount={data.conversations.length}
                  archived={status === 'archived'}
                  busy={bulkBusy}
                  onAll={(on) => setSelected(on ? data.conversations.map((c) => c.id) : [])}
                  onAction={bulk}
                />
              </div>
              {data.conversations.map((c) => (
              <div key={c.id} className={clsx('flex items-start border-b border-newTableBorder/60', openId === c.id ? 'bg-newTableHeader shadow-[inset_3px_0_0_#612BD3]' : 'hover:bg-newTableHeader/60')}>
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id)))}
                className="ms-[10px] mt-[22px] shrink-0 cursor-pointer"
                aria-label={t('select', 'Select')}
              />
              <button type="button" onClick={() => setOpenId(c.id)} className="flex-1 min-w-0 flex gap-[10px] p-[10px] text-start">
                <div className="relative shrink-0">
                  <img src={c.person?.avatar || `/icons/platforms/${c.platform}.png`} className="w-[38px] h-[38px] rounded-full object-cover" alt="" />
                  <img src={`/icons/platforms/${c.platform}.png`} className="w-[18px] h-[18px] rounded-[6px] absolute -bottom-[3px] -end-[5px] border border-fifth" alt={c.platform} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[6px] text-[13px]">
                    <span className={clsx('truncate', c.unread ? 'font-[600]' : 'font-[500]')}>{who(c)}</span>
                    {c.person?.muted && <span className="rounded-full bg-red-900/50 px-[6px] text-[10px]">{t('muted', 'muted')}</span>}
                    <span className="ms-auto text-[11px] text-textItemBlur whitespace-nowrap">{when(c.lastMessageAt)}</span>
                  </div>
                  <div className="flex items-center gap-[6px]">
                    <span className={clsx('truncate text-[12px]', c.unread ? 'text-textColor' : 'text-textItemBlur')}>
                      {c.lastDirection === 'out' ? `${t('you', 'You')}: ` : ''}
                      {c.platform === 'nostr' ? pretty(c.lastPreview || '') : c.lastPreview}
                    </span>
                    {!!c.unread && <span className="ms-auto min-w-[18px] h-[18px] px-[5px] rounded-full bg-red-500 text-white text-[10px] font-[600] flex items-center justify-center">{c.unread}</span>}
                  </div>
                </div>
              </button>
              </div>
              ))}
            </>
          )}
          {!!data && data.pages > 1 && (
            <div className="flex gap-[8px] justify-center p-[8px] text-[12px]">
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="px-[10px] h-[26px] rounded-[6px] border border-newTableBorder disabled:opacity-40">{t('previous', 'Previous')}</button>
              <span className="self-center text-textItemBlur">{page + 1} / {data.pages}</span>
              <button type="button" disabled={page >= data.pages - 1} onClick={() => setPage(page + 1)} className="px-[10px] h-[26px] rounded-[6px] border border-newTableBorder disabled:opacity-40">{t('next', 'Next')}</button>
            </div>
          )}
        </div>
        {open ? (
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <button type="button" onClick={() => setOpenId(null)} className="hidden mobile:block text-start text-[13px] px-[12px] py-[8px] border-b border-newTableBorder">
              ← {t('back', 'Back')}
            </button>
            <Thread key={open.id} convo={open} channel={channelById.get(open.integrationId)} allTags={allTags} onChanged={changed} />
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[13px] text-textItemBlur mobile:hidden">{t('dm_pick', 'Pick a conversation')}</div>
        )}
      </div>
    </div>
  );
};
