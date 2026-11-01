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

type Slot = { day: number; minute: number; source?: 'data' | 'filler' };
type Channel = { id: string; name: string; picture: string | null; providerIdentifier: string };
type WeekItem = { at: string; kind: 'open' | 'filled' | 'custom'; post: { id: string; text: string } | null };
type QueueRow = {
  integration: Channel;
  queue: {
    timeZone: string;
    slots: Slot[];
    paused: boolean;
    daysOff: string[];
    perDay: Record<number, number>;
    autoAdjust: boolean;
    lastAdjustedAt: string | null;
  } | null;
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
  JSON.stringify(sortSlots(a).map((x) => [x.day, x.minute])) === JSON.stringify(sortSlots(b).map((x) => [x.day, x.minute]));
const samePerDay = (a: Record<number, number>, b: Record<number, number>) =>
  DAYS.every((d) => (a[d] ?? -1) === (b[d] ?? -1));

const Stepper: FC<{ value: number | undefined; onChange: (v: number | undefined) => void }> = ({ value, onChange }) => (
  <div className="flex items-center gap-[2px] text-[11px]" title="Posts this day">
    <button type="button" onClick={() => onChange(value === undefined ? 0 : value > 0 ? value - 1 : undefined)} className="w-[18px] h-[18px] rounded-[4px] border border-newTableBorder leading-none">−</button>
    <span className="w-[16px] text-center">{value ?? '–'}</span>
    <button type="button" onClick={() => onChange(Math.min(12, (value ?? 0) + 1))} className="w-[18px] h-[18px] rounded-[4px] border border-newTableBorder leading-none">+</button>
  </div>
);

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
  const [perDay, setPerDay] = useState<Record<number, number>>(original?.perDay || {});
  const [autoAdjust, setAutoAdjust] = useState(!!original?.autoAdjust);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    setTimeZone(row.queue?.timeZone || browserZone());
    setSlots(row.queue?.slots || []);
    setPerDay(row.queue?.perDay || {});
    setAutoAdjust(!!row.queue?.autoAdjust);
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
    original.autoAdjust !== autoAdjust ||
    !samePerDay(original.perDay || {}, perDay) ||
    !sameSlots(original.slots, slots);
  const setCount = (day: number, v: number | undefined) => {
    const next = { ...perDay };
    if (v === undefined) delete next[day];
    else next[day] = v;
    setPerDay(next);
  };
  const hasCounts = DAYS.some((d) => perDay[d] !== undefined);
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
      body: JSON.stringify({ timeZone, slots, perDay, autoAdjust }),
    });
    setSaving(false);
    if (!res.ok) {
      toaster.show((await res.json().catch(() => ({})))?.message || t('could_not_save', 'Could not save'), 'warning');
      return;
    }
    toaster.show(t('queue_saved', 'Queue saved'), 'success');
    onSaved();
  };

  // save first (timezone, counts), then let the server pick each day's best times
  const pickBest = async () => {
    setPicking(true);
    const saved = await fetch(`/queue/${row.integration.id}`, {
      method: 'PUT',
      body: JSON.stringify({ timeZone, slots, perDay, autoAdjust }),
    });
    const res = saved.ok
      ? await fetch(`/queue/${row.integration.id}/auto-pick`, { method: 'POST', body: JSON.stringify({ perDay }) })
      : saved;
    setPicking(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toaster.show(body?.message || t('could_not_pick', 'Could not pick times'), 'warning');
      return;
    }
    setSlots(body.slots || []);
    setPerDay(body.perDay || perDay);
    toaster.show(t('picked_best_times', 'Picked the best times for each day'), 'success');
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
        <label className="flex items-center gap-[6px] cursor-pointer select-none" title={t('auto_adjust_hint', 'Every Sunday at 5 AM, re-pick each day’s best times for your counts. Scheduled posts keep their times.')}>
          <input type="checkbox" checked={autoAdjust} onChange={(e) => setAutoAdjust(e.target.checked)} />
          {t('keep_times_updated', 'Keep times updated every Sunday')}
          {original?.lastAdjustedAt && (
            <span className="text-[11px] text-textItemBlur">({t('last_updated', 'last')} {dayjs(original.lastAdjustedAt).format('MMM D')})</span>
          )}
        </label>
        <div className="flex gap-[6px] ms-auto flex-wrap">
          <button
            type="button"
            disabled={!hasCounts || picking}
            onClick={pickBest}
            title={t('pick_best_hint', 'Set how many posts you want on each day (− / + in each column), then pick the best times for those counts')}
            className="px-[10px] h-[32px] rounded-[6px] bg-[#612BD3]/80 text-white whitespace-nowrap disabled:opacity-40"
          >
            {picking ? t('picking', 'Picking…') : t('pick_best_times', 'Pick best times')}
          </button>
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
                <Stepper value={perDay[day]} onChange={(v) => setCount(day, v)} />
              </div>
              {mine.map((s) => (
                <div
                  key={s.minute}
                  title={s.source === 'data' ? t('picked_from_history', 'Picked from your history') : s.source === 'filler' ? t('filler_time', 'Default time: not enough history for this day yet') : undefined}
                  className={clsx(
                    'group flex items-center justify-between gap-[4px] rounded-[6px] px-[8px] h-[28px] text-[12px] whitespace-nowrap',
                    s.source === 'filler' ? 'border border-[#612BD3] text-textColor' : 'bg-[#612BD3]/90 text-white'
                  )}
                >
                  <span>
                    {label(s.minute)}
                    {s.source === 'filler' && <span className="text-[10px] opacity-60 ms-[4px]">{t('default_short', 'default')}</span>}
                  </span>
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

const localDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const Week: FC<{ row: QueueRow; onChanged: () => void }> = ({ row, onChanged }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const tz = row.queue?.timeZone || browserZone();
  const [daysOff, setDaysOff] = useState<string[]>(row.queue?.daysOff || []);
  const [newDay, setNewDay] = useState('');
  useEffect(() => setDaysOff(row.queue?.daysOff || []), [row.integration.id, row.queue?.daysOff?.join(',')]);
  const fmt = (iso: string | Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(iso));

  const saveDaysOff = async (next: string[]) => {
    setDaysOff(next);
    const res = await fetch(`/queue/${row.integration.id}/days-off`, { method: 'PUT', body: JSON.stringify({ daysOff: next, timeZone: tz }) });
    if (!res.ok) toaster.show(t('could_not_save', 'Could not save'), 'warning');
    onChanged();
  };
  const toggleDay = (date: string) => saveDaysOff(daysOff.includes(date) ? daysOff.filter((d) => d !== date) : [...daysOff, date].sort());

  // the next 7 local days, each with its queue times / posts
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + i * 86400000);
    const key = localDate(d, tz);
    return {
      key,
      title: fmt(d, { weekday: 'long', month: 'short', day: 'numeric' }),
      items: row.week.filter((w) => localDate(new Date(w.at), tz) === key),
    };
  });
  const open = row.week.filter((w) => w.kind === 'open').length;
  const filled = row.week.filter((w) => w.kind !== 'open').length;
  const later = daysOff.filter((d) => !days.some((x) => x.key === d));

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="text-[13px] text-textItemBlur">
        {t('queue_week_counts', '{{filled}} scheduled · {{open}} open in the next 7 days', { filled, open })}
      </div>
      {days.map((day) => {
        const off = daysOff.includes(day.key);
        return (
          <div key={day.key} className="flex flex-col gap-[4px]">
            <div className="flex items-center gap-[8px] text-[13px]">
              <span className={clsx('font-[500]', off && 'line-through text-textItemBlur')}>{day.title}</span>
              <label className="ms-auto flex items-center gap-[4px] text-[11px] text-textItemBlur cursor-pointer" title={t('day_off_hint', 'Skip queue times this day. Posts you schedule directly still go out.')}>
                <input type="checkbox" checked={off} onChange={() => toggleDay(day.key)} />
                {t('day_off', 'Day off')}
              </label>
            </div>
            {off && !day.items.length && <div className="text-[12px] text-textItemBlur ps-[2px]">{t('no_queue_this_day', 'No queued posts this day')}</div>}
            {day.items.map((w, i) => (
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
        );
      })}
      <div className="border-t border-newTableBorder pt-[10px] flex flex-col gap-[6px] text-[13px]">
        <div className="font-[500]">{t('days_off_later', 'Days off later')}</div>
        <form
          className="flex gap-[6px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (newDay && !daysOff.includes(newDay)) saveDaysOff([...daysOff, newDay].sort());
            setNewDay('');
          }}
        >
          <input
            type="date"
            value={newDay}
            min={localDate(new Date(), tz)}
            onChange={(e) => setNewDay(e.target.value)}
            className="bg-newBgColorInner border border-newTableBorder rounded-[6px] h-[30px] px-[8px] flex-1 min-w-0"
          />
          <button type="submit" disabled={!newDay} className="px-[10px] h-[30px] rounded-[6px] bg-[#612BD3] text-white disabled:opacity-40">
            {t('add', 'Add')}
          </button>
        </form>
        <div className="flex flex-wrap gap-[6px]">
          {later.map((d) => (
            <span key={d} className="flex items-center gap-[4px] rounded-full border border-newTableBorder px-[8px] h-[24px] text-[12px]">
              {dayjs(d).format('ddd MMM D, YYYY')}
              <button type="button" onClick={() => saveDaysOff(daysOff.filter((x) => x !== d))} className="opacity-60 hover:opacity-100">×</button>
            </span>
          ))}
          {!later.length && <span className="text-[12px] text-textItemBlur">{t('days_off_hint', 'Holidays like Dec 25: the queue skips them, anything you schedule directly still posts.')}</span>}
        </div>
      </div>
    </div>
  );
};

const PauseBar: FC<{ onChanged: () => void }> = ({ onChanged }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const { data, mutate } = useSWR<{ paused: boolean; pausedAt: string | null; held: number }>('/queue/pause', get, { refreshInterval: 30000 });
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const toggle = async () => {
    const pausing = !data.paused;
    if (
      !window.confirm(
        pausing
          ? t('confirm_pause', 'Pause all posting? Nothing will be published on any channel until you resume.')
          : t('confirm_resume', 'Resume posting? Posts whose time passed while paused go into each channel’s next open queue time.')
      )
    )
      return;
    setBusy(true);
    const res = await fetch('/queue/pause', { method: 'PUT', body: JSON.stringify({ paused: pausing }) });
    setBusy(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toaster.show(t('could_not_save', 'Could not save'), 'warning');
    toaster.show(
      pausing
        ? t('paused_n', 'Posting paused. {{n}} scheduled posts are on hold.', { n: body.stopped ?? 0 })
        : t('resumed_n', 'Posting resumed: {{a}} kept their time, {{b}} moved into the queue.', { a: body.restarted ?? 0, b: body.requeued ?? 0 }),
      'success'
    );
    mutate();
    onChanged();
  };
  return (
    <div
      className={clsx(
        'flex items-center gap-[12px] rounded-[8px] px-[14px] py-[10px] text-[13px] border',
        data.paused ? 'bg-red-900/30 border-red-700' : 'bg-newTableHeader border-newTableBorder'
      )}
    >
      <span className={clsx('w-[10px] h-[10px] rounded-full', data.paused ? 'bg-red-500' : 'bg-green-500')} />
      {data.paused ? (
        <span>
          <span className="font-[500]">{t('posting_paused', 'All posting is paused')}</span>
          {data.pausedAt && ` ${t('since', 'since')} ${dayjs(data.pausedAt).format('MMM D, h:mm A')}`} · {t('n_on_hold', '{{n}} posts on hold', { n: data.held })}
        </span>
      ) : (
        <span>{t('posting_live', 'Posting is on for all channels')}</span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={toggle}
        className={clsx('ms-auto px-[14px] h-[32px] rounded-[6px] text-white whitespace-nowrap disabled:opacity-40', data.paused ? 'bg-green-700' : 'bg-red-700')}
      >
        {busy ? t('working', 'Working…') : data.paused ? t('resume_posting', 'Resume posting') : t('pause_all_posting', 'Pause all posting')}
      </button>
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
      <PauseBar onChanged={() => mutate()} />
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
                  {!r.queue || n === 0 ? t('no_queue', 'No queue') : t('times_per_week', '{{n}} times a week', { n })}
                  {r.queue?.autoAdjust ? ` · ${t('auto', 'auto')}` : ''}
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
          <Week row={row} onChanged={() => mutate()} />
        </div>
      </div>
    </div>
  );
};
