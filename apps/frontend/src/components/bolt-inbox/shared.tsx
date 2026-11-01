'use client';

// Bolt Advantage: pieces the inbox's mentions and messages views share.
import React, { FC, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

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
export type Channel = { id: string; name: string; picture: string | null; identifier: string };
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

