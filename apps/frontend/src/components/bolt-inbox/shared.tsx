'use client';

// Bolt Advantage: pieces the inbox's mentions and messages views share.
import React, { FC, useState } from 'react';
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
export const SelectionBar: FC<{
  count: number;
  pageCount: number;
  archived: boolean;
  busy: boolean;
  onAll: (on: boolean) => void;
  onAction: (action: 'read' | 'archive' | 'unarchive' | 'delete') => void;
}> = ({ count, pageCount, archived, busy, onAll, onAction }) => {
  const t = useT();
  const btn = 'px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40';
  return (
    <div className="flex flex-wrap items-center gap-[6px] text-[12px] rounded-[8px] bg-newTableHeader px-[10px] py-[6px]">
      <label className="flex items-center gap-[6px] cursor-pointer me-[6px]">
        <input type="checkbox" checked={count > 0 && count === pageCount} onChange={(e) => onAll(e.target.checked)} />
        {count ? t('n_selected', '{{n}} selected', { n: count }) : t('select_all_page', 'Select all on this page')}
      </label>
      {count > 0 && (
        <>
          <button type="button" disabled={busy} onClick={() => onAction('read')} className={btn}>{t('mark_read', 'Mark read')}</button>
          <button type="button" disabled={busy} onClick={() => onAction(archived ? 'unarchive' : 'archive')} className={btn}>
            {archived ? t('unarchive', 'Unarchive') : t('archive', 'Archive')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('confirm_delete_inbox', 'Delete {{n}} from the inbox? This only removes them here, not on the social network, and can’t be undone.', { n: count }))) onAction('delete');
            }}
            className={`${btn} text-red-400`}
          >
            {t('delete', 'Delete')}
          </button>
          <button type="button" onClick={() => onAll(false)} className="px-[8px] h-[28px] underline">{t('clear', 'Clear')}</button>
        </>
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
