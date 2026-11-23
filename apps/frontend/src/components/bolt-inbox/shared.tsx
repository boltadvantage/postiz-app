'use client';

// Bolt Advantage: pieces the inbox's mentions and messages views share.
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { ChannelAvatar } from '@gitroom/frontend/components/bolt-shared/channel.avatar';

export type Person = {
  id: string;
  platform: string;
  authorId: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  tags: string[];
  muted: boolean;
  note: string | null;
};
export type Channel = {
  id: string;
  name: string;
  picture: string | null;
  identifier: string;
  additionalSettings?: string;
  display?: string | null;
  customer?: { id: string; name: string } | null;
  type?: string;
  disabled?: boolean;
};
export type Status = 'open' | 'unread' | 'archived' | 'all';

// Nostr clients render nostr: links as embeds; show a short label instead of the raw code
export const pretty = (s: string) =>
  s.replace(/nostr:(note|nevent|npub|nprofile|naddr)1[0-9a-z]+/g, (_m, type: string) =>
    type === 'npub' || type === 'nprofile' ? '↗ profile' : '↗ note'
  );

export const PersonPanel: FC<{ person: Person; allTags: string[]; onSaved: () => void; onClose: () => void }> = ({ person, allTags, onSaved, onClose }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [tags, setTags] = useState<string[]>(person.tags);
  const [draft, setDraft] = useState('');
  const [muted, setMuted] = useState(person.muted);
  const [note, setNote] = useState(person.note || '');
  const [saving, setSaving] = useState(false);
  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase().slice(0, 30);
    if (tag && !tags.includes(tag)) setTags([...tags, tag]);
    setDraft('');
  };
  const save = async () => {
    setSaving(true);
    const res = await fetch(`/inbox/people/${person.id}`, { method: 'PUT', body: JSON.stringify({ tags, muted, note }) });
    setSaving(false);
    if (!res.ok) return toaster.show(t('could_not_save', 'Could not save'), 'warning');
    toaster.show(muted ? t('person_muted', 'Muted. Their posts are hidden and new ones won’t be saved.') : t('saved', 'Saved'), 'success');
    onSaved();
    onClose();
  };
  const suggestions = allTags.filter((x) => !tags.includes(x) && (!draft || x.includes(draft.toLowerCase()))).slice(0, 6);
  return (
    <div className="mt-[8px] rounded-[8px] border border-newTableBorder bg-newBgColorInner p-[12px] flex flex-col gap-[10px] text-[13px]">
      <div className="flex items-center gap-[8px]">
        <span className="font-[500]">{person.name || person.handle || t('unknown', 'Unknown')}</span>
        <span className="text-textItemBlur">{person.handle ? `@${person.handle}` : ''}</span>
        <span className="ms-auto text-[11px] text-textItemBlur">{t('private_to_you', 'Only visible in your inbox')}</span>
      </div>
      <div className="flex flex-wrap items-center gap-[6px]">
        {tags.map((tag) => (
          <span key={tag} className="flex items-center gap-[4px] rounded-full bg-[#612BD3]/30 px-[8px] h-[24px]">
            {tag}
            <button type="button" onClick={() => setTags(tags.filter((x) => x !== tag))} className="opacity-60 hover:opacity-100">×</button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addTag(draft);
            }
          }}
          placeholder={t('add_tag', 'Add tag…')}
          className="bg-transparent border border-newTableBorder rounded-full px-[10px] h-[24px] outline-none w-[120px]"
        />
        {suggestions.map((s) => (
          <button key={s} type="button" onClick={() => addTag(s)} className="rounded-full border border-dashed border-newTableBorder px-[8px] h-[24px] text-textItemBlur">
            + {s}
          </button>
        ))}
      </div>
      <label className="flex items-start gap-[8px] cursor-pointer">
        <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} className="mt-[2px]" />
        <span>
          {t('mute_person', 'Mute this person')}
          <span className="block text-[12px] text-textItemBlur">
            {t('mute_explain', 'Hides everything from them here and stops saving their new posts. They aren’t blocked or notified. Unmute any time.')}
          </span>
        </span>
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder={t('private_note', 'Private note…')}
        className="bg-transparent border border-newTableBorder rounded-[6px] p-[8px] outline-none resize-y"
      />
      <div className="flex gap-[8px] justify-end">
        <button type="button" onClick={onClose} className="px-[12px] h-[30px] rounded-[6px] border border-newTableBorder">{t('cancel', 'Cancel')}</button>
        <button type="button" disabled={saving} onClick={save} className="px-[14px] h-[30px] rounded-[6px] bg-[#612BD3] text-white disabled:opacity-40">
          {saving ? t('saving', 'Saving…') : t('save', 'Save')}
        </button>
      </div>
    </div>
  );
};


/** Shown while items are selected: act on all of them at once. */
/** Tag, mute or add a note for everyone behind the selected items, in one go. */
const BulkPeople: FC<{ people: Person[]; allTags: string[]; onSaved: () => void; onClose: () => void }> = ({ people, allTags, onSaved, onClose }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [mute, setMute] = useState<'' | 'mute' | 'unmute'>('');
  const [note, setNote] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  // tags anyone selected already has, so they can be taken off
  const present = [...new Set(people.flatMap((p) => p.tags))].sort();
  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase().slice(0, 30);
    if (tag && !add.includes(tag)) setAdd([...add, tag]);
    setDraft('');
  };
  const suggestions = allTags.filter((x) => !add.includes(x) && (!draft || x.includes(draft.toLowerCase()))).slice(0, 6);
  const changed = add.length || remove.length || mute || note.trim() || (replace && !note.trim());
  const save = async () => {
    if (mute === 'mute' && !window.confirm(t('bulk_mute_confirm', 'Mute {{n}} people? Their posts are hidden and new ones won’t be saved.', { n: people.length }))) return;
    setBusy(true);
    const body: any = { ids: people.map((p) => p.id) };
    if (add.length) body.addTags = add;
    if (remove.length) body.removeTags = remove;
    if (mute) body.muted = mute === 'mute';
    if (note.trim() || replace) {
      body.note = note.trim() || null;
      body.noteMode = replace ? 'replace' : 'append';
    }
    const res = await fetch('/inbox/people', { method: 'PUT', body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return toaster.show(b?.message || t('could_not_save', 'Could not save'), 'warning');
    }
    toaster.show(t('bulk_people_saved', 'Updated {{n}} people', { n: people.length }), 'success');
    onSaved();
    onClose();
  };
  const chip = 'rounded-full px-[8px] h-[22px] text-[11px] flex items-center gap-[4px]';
  return (
    <div className="w-full mt-[6px] rounded-[8px] bg-newBgColorInner border border-newTableBorder p-[10px] flex flex-col gap-[10px] text-[12px]">
      <div className="text-textItemBlur">
        {t('bulk_people_for', 'For {{n}} people:', { n: people.length })} {people.slice(0, 6).map((p) => p.name || p.handle || '?').join(', ')}
        {people.length > 6 ? ` +${people.length - 6}` : ''}
      </div>
      <div className="flex flex-col gap-[6px]">
        <div className="flex flex-wrap items-center gap-[6px]">
          <span className="text-textItemBlur">{t('add_tags', 'Add tags')}</span>
          {add.map((tag) => (
            <span key={tag} className={`${chip} bg-[#612BD3] text-white`}>
              {tag}
              <button type="button" onClick={() => setAdd(add.filter((x) => x !== tag))} className="opacity-70 hover:opacity-100">×</button>
            </span>
          ))}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag(draft);
              }
            }}
            placeholder={t('type_a_tag', 'type a tag, Enter')}
            className="bg-newTableHeader border border-newTableBorder rounded-[6px] h-[26px] px-[8px] outline-none w-[140px]"
          />
          {suggestions.map((x) => (
            <button key={x} type="button" onClick={() => addTag(x)} className={`${chip} bg-[#612BD3]/20 hover:bg-[#612BD3]/40`}>
              + {x}
            </button>
          ))}
        </div>
        {!!present.length && (
          <div className="flex flex-wrap items-center gap-[6px]">
            <span className="text-textItemBlur">{t('remove_tags', 'Take off')}</span>
            {present.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setRemove(remove.includes(tag) ? remove.filter((x) => x !== tag) : [...remove, tag])}
                className={clsx(chip, remove.includes(tag) ? 'bg-red-600 text-white line-through' : 'bg-newTableHeader')}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-[10px]">
        <span className="text-textItemBlur">{t('mute', 'Mute')}</span>
        {(['', 'mute', 'unmute'] as const).map((m) => (
          <label key={m || 'leave'} className="flex items-center gap-[4px] cursor-pointer">
            <input type="radio" checked={mute === m} onChange={() => setMute(m)} />
            {m === 'mute' ? t('mute_them', 'Mute them') : m === 'unmute' ? t('unmute_them', 'Unmute them') : t('leave_as_is', 'Leave as is')}
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-[4px]">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder={t('bulk_note_placeholder', 'Note (added as a new line to each person’s note)')}
          className="bg-newTableHeader border border-newTableBorder rounded-[6px] p-[6px] outline-none resize-y"
        />
        <label className="flex items-center gap-[6px] cursor-pointer text-textItemBlur">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          {t('replace_notes', 'Replace their notes instead (empty = clear them)')}
        </label>
      </div>
      <div className="flex gap-[6px]">
        <button type="button" disabled={busy || !changed} onClick={save} className="px-[12px] h-[28px] rounded-[6px] bg-[#612BD3] text-white disabled:opacity-40">
          {busy ? t('saving', 'Saving…') : t('apply', 'Apply')}
        </button>
        <button type="button" onClick={onClose} className="px-[10px] h-[28px] rounded-[6px] hover:bg-newTableHeader">
          {t('cancel', 'Cancel')}
        </button>
      </div>
    </div>
  );
};

/** People behind the selected items, once each; unnamed Facebook commenters can't be tagged meaningfully. */
export const selectedPeople = (items: Array<{ id: string; person: Person | null }>, selected: string[]) => {
  const byId = new Map<string, Person>();
  for (const i of items) if (selected.includes(i.id) && i.person && !i.person.authorId.startsWith('anon:')) byId.set(i.person.id, i.person);
  return [...byId.values()];
};

export const SelectionBar: FC<{
  count: number;
  pageCount: number;
  archived: boolean;
  busy: boolean;
  onAll: (on: boolean) => void;
  onAction: (action: 'read' | 'archive' | 'unarchive' | 'delete') => void;
  /** who the selected items are from, for tagging, muting or noting them all at once */
  people?: Person[];
  allTags?: string[];
  onPeopleSaved?: () => void;
  /** "select everything": how many match the filters on all pages, and whether they're all selected */
  total?: number;
  allMatching?: boolean;
  onAllMatching?: (on: boolean) => void;
}> = ({ count, pageCount, archived, busy, onAll, onAction, people, allTags, onPeopleSaved, total, allMatching, onAllMatching }) => {
  const t = useT();
  const [bulk, setBulk] = useState(false);
  useEffect(() => {
    if (!count) setBulk(false);
  }, [count]);
  const btn = 'px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40';
  return (
    <div className="flex flex-wrap items-center gap-[6px] text-[12px] rounded-[8px] bg-newTableHeader px-[10px] py-[6px]">
      <label className="flex items-center gap-[6px] cursor-pointer me-[6px]">
        <input type="checkbox" checked={allMatching || (count > 0 && count === pageCount)} onChange={(e) => onAll(e.target.checked)} />
        {allMatching
          ? t('all_n_selected', 'All {{n}} selected', { n: total })
          : count
          ? t('n_selected', '{{n}} selected', { n: count })
          : t('select_all_page', 'Select all on this page')}
      </label>
      {onAllMatching && total !== undefined && total > pageCount && (
        <button type="button" onClick={() => onAllMatching(!allMatching)} className="px-[8px] h-[28px] underline text-[#a78bfa]">
          {allMatching ? t('only_this_page', 'Only this page') : t('select_everything', 'Select all {{n}}', { n: total })}
        </button>
      )}
      {(count > 0 || allMatching) && (
        <>
          <button type="button" disabled={busy} onClick={() => onAction('read')} className={btn}>{t('mark_read', 'Mark read')}</button>
          <button type="button" disabled={busy} onClick={() => onAction(archived ? 'unarchive' : 'archive')} className={btn}>
            {archived ? t('unarchive', 'Unarchive') : t('archive', 'Archive')}
          </button>
          {people && onPeopleSaved && (
            <button
              type="button"
              disabled={busy || !people.length}
              onClick={() => setBulk(!bulk)}
              className={clsx(btn, bulk && 'bg-[#612BD3] text-white border-[#612BD3]')}
              title={!people.length ? t('bulk_people_none', 'Nobody to tag: Facebook hasn’t named these yet') : undefined}
            >
              {t('tag_mute_note', 'Tag / mute / note')} ({people.length})
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('confirm_delete_inbox', 'Delete {{n}} from the inbox? This only removes them here, not on the social network, and can’t be undone.', { n: allMatching ? total : count }))) onAction('delete');
            }}
            className={`${btn} text-red-400`}
          >
            {t('delete', 'Delete')}
          </button>
          <button type="button" onClick={() => onAll(false)} className="px-[8px] h-[28px] underline">{t('clear', 'Clear')}</button>
        </>
      )}
      {bulk && people && onPeopleSaved && !!people.length && (
        <BulkPeople people={people} allTags={allTags || []} onSaved={onPeopleSaved} onClose={() => setBulk(false)} />
      )}
    </div>
  );
};

export type FollowSetting = { on: boolean; verified: boolean; minFollowers: number };

/** A channel's Follows setting: off, everyone, or only notable followers. */
const FollowSettingRow: FC<{ channel: Channel; setting?: FollowSetting; onChanged: () => void }> = ({ channel, setting, onChanged }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const s = setting || { on: false, verified: false, minFollowers: 0 };
  const [min, setMin] = useState(s.minFollowers ? String(s.minFollowers) : '');
  const save = async (input: Partial<FollowSetting>) => {
    const res = await fetch(`/inbox/follows/settings/${channel.id}`, { method: 'PUT', body: JSON.stringify(input) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toaster.show(body?.message || t('could_not_save', 'Could not save'), 'warning');
    }
    onChanged();
  };
  return (
    <>
      <label className="flex items-center gap-[6px] cursor-pointer">
        <input type="checkbox" checked={s.on} onChange={(e) => save({ on: e.target.checked })} />
        {t('check_follows', 'Show new followers')}
      </label>
      {s.on && (
        <div className="flex flex-col gap-[4px] ps-[20px]">
          <span>{t('follows_only', 'Only show them if they are…')}</span>
          <label className="flex items-center gap-[6px] cursor-pointer">
            <input type="checkbox" checked={s.verified} onChange={(e) => save({ verified: e.target.checked })} />
            {channel.identifier === 'nostr' ? t('follows_verified_nostr', 'verified (NIP-05)') : t('follows_verified', 'verified')}
          </label>
          <label className="flex items-center gap-[6px]">
            {t('follows_and_min', 'and have at least')}
            <input
              type="number"
              min="0"
              inputMode="numeric"
              value={min}
              placeholder="0"
              onChange={(e) => setMin(e.target.value)}
              onBlur={() => Number(min || 0) !== s.minFollowers && save({ minFollowers: Number(min || 0) })}
              className="w-[80px] h-[24px] rounded-[4px] bg-newBgColorInner border border-newTableBorder px-[6px] text-textColor"
            />
            {t('followers_word', 'followers')}
          </label>
          <span>{t('follows_filter_help', 'Leave both empty to show everyone.')}</span>
        </div>
      )}
    </>
  );
};

/** Turn checking a channel's mentions/comments, messages or follows on and off. */
export const ChannelSwitches: FC<{
  channels: Channel[];
  off: { mentions: string[]; messages: string[] };
  dmPlatforms: string[];
  mentionPlatforms?: string[];
  onChanged: () => void;
  follows?: Record<string, FollowSetting>;
  followPlatforms?: string[];
  onFollowsChanged?: () => void;
}> = ({ channels, off, dmPlatforms, mentionPlatforms, onChanged, follows, followPlatforms = [], onFollowsChanged }) => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const set = async (id: string, what: 'mentions' | 'messages', on: boolean) => {
    const res = await fetch(`/inbox/switches/${id}`, { method: 'PUT', body: JSON.stringify({ [what]: on }) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toaster.show(body?.message || t('could_not_save', 'Could not save'), 'warning');
    }
    onChanged();
  };
  return (
    <details className="text-[12px] text-textItemBlur">
      <summary className="cursor-pointer">{t('channel_checks', 'Turn channels on or off')}</summary>
      <div className="flex flex-col gap-[8px] mt-[8px]">
        {channels.map((c) => (
          <div key={c.id} className="flex flex-col gap-[2px]">
            <span className="text-textColor truncate">
              {c.name} <span className="text-textItemBlur">({c.identifier})</span>
            </span>
            {(!mentionPlatforms || mentionPlatforms.includes(c.identifier)) && (
              <label className="flex items-center gap-[6px] cursor-pointer">
                <input type="checkbox" checked={!off.mentions.includes(c.id)} onChange={(e) => set(c.id, 'mentions', e.target.checked)} />
                {c.identifier === 'facebook' || c.identifier === 'instagram' ? t('check_comments', 'Check comments') : t('check_mentions', 'Check mentions')}
              </label>
            )}
            {dmPlatforms.includes(c.identifier) && (
              <label className="flex items-center gap-[6px] cursor-pointer">
                <input type="checkbox" checked={!off.messages.includes(c.id)} onChange={(e) => set(c.id, 'messages', e.target.checked)} />
                {t('check_messages', 'Check messages')}
              </label>
            )}
            {follows && followPlatforms.includes(c.identifier) && (
              <FollowSettingRow channel={c} setting={follows[c.id]} onChanged={() => onFollowsChanged?.()} />
            )}
          </div>
        ))}
        <span>{t('channel_checks_help', 'Off means nothing new is fetched for it. What’s already here stays.')}</span>
      </div>
    </details>
  );
};

const PLATFORM_NAMES: Record<string, string> = { x: 'X', nostr: 'Nostr', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', 'linkedin-page': 'LinkedIn Page' };
export const platformName = (identifier: string) => PLATFORM_NAMES[identifier] || identifier;

/** A channel's sync problem, saying exactly which account it is (several can share a name and picture). */
export const ProblemNote: FC<{ channel?: Channel; message: string }> = ({ channel, message }) => {
  const t = useT();
  return (
    <div className="flex items-start gap-[10px] rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-[12px] py-[8px] text-[13px]">
      {channel && <ChannelAvatar picture={channel.picture} platform={channel.identifier} size={24} />}
      <div className="min-w-0">
        <b>
          {channel ? `${channel.name} · ${platformName(channel.identifier)}` : t('channel', 'Channel')}
          {channel?.display ? ` (@${channel.display.replace(/^@/, '')})` : ''}:
        </b>{' '}
        {message}
      </div>
    </div>
  );
};

/**
 * A button that only fires after being held down: a fill sweeps left to right
 * and the action runs when it reaches the end. Letting go early cancels, so a
 * stray click can't trigger it. Works with mouse, touch, and Space/Enter.
 */
export const HoldButton: FC<{ label: string; hint: string; onConfirm: () => void; disabled?: boolean; ms?: number; className?: string }> = ({
  label,
  hint,
  onConfirm,
  disabled,
  ms = 1200,
  className,
}) => {
  const [holding, setHolding] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (started.current && Date.now() - started.current < ms) {
      // let go too soon: say how it works
      setShowHint(true);
      setTimeout(() => setShowHint(false), 1800);
    }
    started.current = 0;
    setHolding(false);
  }, [ms]);

  const start = useCallback(() => {
    if (disabled || timer.current) return;
    started.current = Date.now();
    setShowHint(false);
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      started.current = 0;
      setHolding(false);
      onConfirm();
    }, ms);
  }, [disabled, ms, onConfirm]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <button
      type="button"
      disabled={disabled}
      title={hint}
      aria-label={`${label}: ${hint}`}
      onPointerDown={(e) => {
        e.preventDefault();
        start();
      }}
      onPointerUp={stop}
      onPointerLeave={() => timer.current && stop()}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && stop()}
      onBlur={() => timer.current && stop()}
      className={clsx('relative overflow-hidden select-none touch-none', className)}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 start-0 bg-red-500/40"
        style={{ width: holding ? '100%' : '0%', transition: holding ? `width ${ms}ms linear` : 'width 150ms ease-out' }}
      />
      <span className="relative">{showHint ? hint : label}</span>
    </button>
  );
};
