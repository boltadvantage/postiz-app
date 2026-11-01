'use client';

// Bolt Advantage: per-channel posting queue — your own times for each weekday,
// suggestions from your saved analytics, and what the week looks like.
import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

type Slot = { day: number; minute: number };
type Channel = { id: string; name: string; picture: string | null; providerIdentifier: string };
type WeekItem = { at: string; kind: 'open' | 'filled' | 'custom'; post: { id: string; text: string } | null };
type QueueRow = {
  integration: Channel;
  queue: { timeZone: string; slots: Slot[]; paused: boolean } | null;
  next: string | null;
  week: WeekItem[];
};
type Suggestion = Slot & { posts: number; avgEngagement: number; lift: number };
type Suggestions = {
  source: 'channel' | 'all-channels';
  sampleSize: number;
  channelSampleSize?: number;
  timeZone: string;
  suggestions: Suggestion[];
};

// Monday first, like most calendars
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// compact: "9 AM", "1:30 PM" (day columns are narrow)
const label = (m: number) =>
  `${((Math.floor(m / 60) + 11) % 12) + 1}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''} ${m < 720 ? 'AM' : 'PM'}`;
const toMinute = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const browserZone = () => (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');
const zones = (): string[] => {
  try {
    return (Intl as any).supportedValuesOf('timeZone');
  } catch {
    return [browserZone(), 'UTC'];
  }
};
const sortSlots = (s: Slot[]) =>
  [...s].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.minute - b.minute);
const sameSlots = (a: Slot[], b: Slot[]) =>
  JSON.stringify(sortSlots(a)) === JSON.stringify(sortSlots(b));

const AddTime: FC<{ onAdd: (minute: number) => void }> = ({ onAdd }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('09:00');
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-[12px] text-textItemBlur hover:text-textColor h-[28px]">
        + {t('add_time', 'Add time')}
      </button>
    );
  }
  return (
    <form
      className="flex gap-[4px]"
      onSubmit={(e) => {
        e.preventDefault();
        const m = toMinute(value);
        if (m !== null) onAdd(m);
        setOpen(false);
      }}
    >
      <input
        type="time"
        step={300}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="bg-newBgColorInner border border-newTableBorder rounded-[6px] px-[6px] h-[28px] text-[12px] w-full min-w-0"
      />
      <button type="submit" className="px-[8px] h-[28px] rounded-[6px] bg-[#612BD3] text-white text-[12px]">
        {t('add', 'Add')}
      </button>
    </form>
  );
};

const Editor: FC<{ row: QueueRow; onSaved: () => void }> = ({ row, onSaved }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const original = row.queue;
  const [timeZone, setTimeZone] = useState(original?.timeZone || browserZone());
  const [slots, setSlots] = useState<Slot[]>(original?.slots || []);
  const [paused, setPaused] = useState(!!original?.paused);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTimeZone(row.queue?.timeZone || browserZone());
    setSlots(row.queue?.slots || []);
    setPaused(!!row.queue?.paused);
  }, [row.integration.id]);

  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const { data: sug } = useSWR<Suggestions>(
    `/queue/${row.integration.id}/suggestions?timeZone=${encodeURIComponent(timeZone)}`,
    get,
    { revalidateOnFocus: false }
  );

  const dirty =
    !original ||
    original.timeZone !== timeZone ||
    original.paused !== paused ||
    !sameSlots(original.slots, slots);
  const has = (s: Slot) => slots.some((x) => x.day === s.day && x.minute === s.minute);
  const add = (s: Slot) => !has(s) && setSlots(sortSlots([...slots, s]));
  const remove = (s: Slot) => setSlots(slots.filter((x) => !(x.day === s.day && x.minute === s.minute)));
  const copyDay = (from: number, to: number[]) =>
    setSlots(sortSlots([...slots.filter((s) => !to.includes(s.day)), ...to.flatMap((d) => slots.filter((s) => s.day === from).map((s) => ({ day: d, minute: s.minute })))]));
  const fresh = (sug?.suggestions || []).filter((s) => !has(s));

  const save = async () => {
    setSaving(true);
    const res = await fetch(`/queue/${row.integration.id}`, {
      method: 'PUT',
      body: JSON.stringify({ timeZone, slots, paused }),
    });
    setSaving(false);
    if (!res.ok) {
      toaster.show((await res.json().catch(() => ({})))?.message || t('could_not_save', 'Could not save'), 'warning');
      return;
    }
    toaster.show(t('queue_saved', 'Queue saved'), 'success');
    onSaved();
  };

  const zoneList = useMemo(zones, []);

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="flex flex-wrap items-center gap-[10px] text-[13px]">
        <label className="flex items-center gap-[6px]">
          <span className="text-textItemBlur">{t('timezone', 'Timezone')}</span>
          <select
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="bg-newBgColorInner border border-newTableBorder rounded-[6px] h-[32px] px-[8px] max-w-[220px]"
          >
            {[...new Set([timeZone, ...zoneList])].map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-[6px] cursor-pointer select-none">
          <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
          {t('pause_queue', 'Pause queue')}
        </label>
        <div className="flex gap-[6px] ms-auto">
          <button type="button" onClick={() => copyDay(1, [2, 3, 4, 5])} className="px-[10px] h-[32px] rounded-[6px] border border-newTableBorder whitespace-nowrap">
            {t('copy_monday_weekdays', 'Copy Mon → weekdays')}
          </button>
          <button type="button" onClick={() => copyDay(1, [2, 3, 4, 5, 6, 0])} className="px-[10px] h-[32px] rounded-[6px] border border-newTableBorder whitespace-nowrap">
            {t('copy_monday_all', 'Copy Mon → all days')}
          </button>
          <button type="button" onClick={() => setSlots([])} className="px-[10px] h-[32px] rounded-[6px] border border-newTableBorder whitespace-nowrap">
            {t('clear', 'Clear')}
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="px-[16px] h-[32px] rounded-[6px] bg-[#612BD3] text-white whitespace-nowrap disabled:opacity-40"
          >
            {saving ? t('saving', 'Saving…') : t('save', 'Save')}
          </button>
        </div>
      </div>

      <div className="rounded-[8px] bg-newBgColorInner border border-newTableBorder p-[12px] text-[13px] flex flex-wrap items-center gap-[10px]">
        {!sug ? (
          <span className="text-textItemBlur">{t('loading_suggestions', 'Looking at your history…')}</span>
        ) : sug.suggestions.length === 0 ? (
          <span className="text-textItemBlur">
            {t('no_suggestions', 'Not enough history to suggest times yet. Suggestions appear once posts have a few weeks of stats on the History page.')}
          </span>
        ) : (
          <>
            <span>
              {sug.source === 'channel'
                ? t('suggest_from_channel', 'Suggested from {{n}} posts on this channel.', { n: sug.sampleSize })
                : t('suggest_from_all', 'Suggested from {{n}} posts across all your channels (this channel only has {{c}} with stats).', {
                    n: sug.sampleSize,
                    c: sug.channelSampleSize || 0,
                  })}{' '}
              <span className="text-textItemBlur">{t('suggest_hint', 'Dashed times below are suggestions; click one to add it.')}</span>
            </span>
            <button
              type="button"
              disabled={!fresh.length}
              onClick={() => setSlots(sortSlots([...slots, ...fresh]))}
              className="ms-auto px-[12px] h-[30px] rounded-[6px] bg-[#612BD3] text-white whitespace-nowrap disabled:opacity-40"
            >
              {fresh.length
                ? t('add_all_suggestions', 'Add all {{n}} suggestions', { n: fresh.length })
                : t('all_suggestions_added', 'All suggestions added')}
            </button>
          </>
        )}
      </div>

      <div className="grid grid-cols-7 mobile:grid-cols-2 gap-[8px]">
        {DAYS.map((day) => {
          const mine = slots.filter((s) => s.day === day);
          const suggested = fresh.filter((s) => s.day === day);
          return (
            <div key={day} className="rounded-[8px] bg-newTableHeader p-[10px] flex flex-col gap-[6px] min-h-[180px]">
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-[500]">{DAY_NAMES[day]}</span>
                <span className="text-[11px] text-textItemBlur">{mine.length || ''}</span>
              </div>
              {mine.map((s) => (
                <div key={s.minute} className="group flex items-center justify-between gap-[4px] rounded-[6px] bg-[#612BD3]/90 text-white px-[8px] h-[28px] text-[12px] whitespace-nowrap">
                  {label(s.minute)}
                  <button type="button" onClick={() => remove(s)} aria-label={t('remove', 'Remove')} className="opacity-60 hover:opacity-100">
                    ×
                  </button>
                </div>
              ))}
              {suggested.map((s) => (
                <button
                  type="button"
                  key={`s${s.minute}`}
                  onClick={() => add(s)}
                  title={t('suggestion_tooltip', '{{avg}} avg engagement over {{n}} posts', { avg: s.avgEngagement, n: s.posts })}
                  className="flex items-center justify-between gap-[4px] rounded-[6px] border border-dashed border-[#8A63E8] px-[6px] h-[28px] text-[12px] text-start whitespace-nowrap overflow-hidden"
                >
                  <span className="truncate">+{label(s.minute)}</span>
                  {s.lift > 0 && <span className="text-[10px] text-green-400 shrink-0">+{Math.round(s.lift * 100)}%</span>}
                </button>
              ))}
              <AddTime onAdd={(minute) => add({ day, minute })} />
            </div>
          );
        })}
      </div>
      {dirty && <div className="text-[12px] text-amber-400 -mt-[6px]">{t('unsaved_queue', 'Unsaved changes')}</div>}
    </div>
  );
};

const Week: FC<{ row: QueueRow }> = ({ row }) => {
  const t = useT();
  const tz = row.queue?.timeZone || browserZone();
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(iso));
  const days = new Map<string, WeekItem[]>();
  for (const w of row.week) {
    const key = fmt(w.at, { weekday: 'long', month: 'short', day: 'numeric' });
    days.set(key, [...(days.get(key) || []), w]);
  }
  const open = row.week.filter((w) => w.kind === 'open').length;
  const filled = row.week.filter((w) => w.kind !== 'open').length;
  if (!row.week.length) {
    return (
      <div className="text-[13px] text-textItemBlur">
        {row.queue?.paused ? t('queue_paused', 'This queue is paused.') : t('queue_empty_week', 'No queue times or scheduled posts in the next 7 days.')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="text-[13px] text-textItemBlur">
        {t('queue_week_counts', '{{filled}} scheduled · {{open}} open in the next 7 days', { filled, open })}
      </div>
      {[...days.entries()].map(([day, items]) => (
        <div key={day} className="flex flex-col gap-[4px]">
          <div className="text-[13px] font-[500]">{day}</div>
          {items.map((w, i) => (
            <div
              key={i}
              className={clsx(
                'flex items-center gap-[10px] rounded-[6px] px-[10px] min-h-[32px] text-[13px]',
                w.kind === 'open' ? 'border border-dashed border-newTableBorder text-textItemBlur' : 'bg-newTableHeader'
              )}
            >
              <span className="w-[64px] shrink-0">{fmt(w.at, { hour: 'numeric', minute: '2-digit' })}</span>
              {w.kind === 'open' ? (
                <span>{t('open_slot', 'Open')}</span>
              ) : (
                <span className="truncate">
                  {w.post?.text || t('untitled_post', '(no text)')}
                  {w.kind === 'custom' && <span className="text-[11px] text-textItemBlur ms-[6px]">{t('outside_queue', 'custom time')}</span>}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

export const Queue = () => {
  const t = useT();
  const fetch = useFetch();
  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const { data, mutate } = useSWR<QueueRow[]>('/queue', get, { revalidateOnFocus: false });
  const [selected, setSelected] = useState('');
  const row = data?.find((r) => r.integration.id === selected) || data?.[0];

  if (!data) {
    return (
      <div className="bg-newBgColorInner p-[20px] flex flex-1 items-center justify-center">
        <LoadingComponent />
      </div>
    );
  }
  if (!row) {
    return <div className="bg-newBgColorInner p-[20px] flex-1 text-[14px] text-textItemBlur">{t('queue_no_channels', 'Connect a channel to set up its queue.')}</div>;
  }

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] overflow-y-auto">
      <div className="flex items-center gap-[12px]">
        <h2 className="text-[20px] font-[500]">{t('queue', 'Queue')}</h2>
        <span className="text-[13px] text-textItemBlur">
          {t('queue_intro', 'Set posting times for each day. "Add to queue" in the post editor puts each channel’s post in its next open time.')}
        </span>
      </div>
      <div className="flex gap-[8px] flex-wrap">
        {data.map((r) => {
          const active = r.integration.id === row.integration.id;
          const n = r.queue?.slots.length || 0;
          return (
            <button
              type="button"
              key={r.integration.id}
              onClick={() => setSelected(r.integration.id)}
              className={clsx('flex items-center gap-[8px] rounded-[8px] px-[10px] h-[44px] border text-start', active ? 'border-[#612BD3] bg-newTableHeader' : 'border-newTableBorder')}
            >
              <img src={r.integration.picture || `/icons/platforms/${r.integration.providerIdentifier}.png`} className="w-[26px] h-[26px] rounded-full" alt="" />
              <div className="flex flex-col leading-tight">
                <span className="text-[13px] max-w-[160px] truncate">{r.integration.name}</span>
                <span className="text-[11px] text-textItemBlur">
                  {!r.queue || n === 0
                    ? t('no_queue', 'No queue')
                    : r.queue.paused
                    ? t('paused', 'Paused')
                    : t('times_per_week', '{{n}} times a week', { n })}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-[1fr_340px] mobile:grid-cols-1 gap-[16px] items-start">
        <div className="rounded-[8px] bg-newTableHeader/40 p-[16px]">
          <Editor key={row.integration.id} row={row} onSaved={() => mutate()} />
        </div>
        <div className="rounded-[8px] bg-newTableHeader p-[16px] flex flex-col gap-[10px]">
          <div className="text-[15px]">{t('this_week', 'This week')}</div>
          {row.next && (
            <div className="text-[13px]">
              {t('next_open', 'Next open:')}{' '}
              <span className="text-[#A98BF0]">{dayjs(row.next).format('ddd MMM D, h:mm A')}</span>
            </div>
          )}
          <Week row={row} />
        </div>
      </div>
    </div>
  );
};
