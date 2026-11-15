'use client';

// Bolt Advantage: alert words per channel. A muted person's comment that uses
// one still reaches the inbox, flagged, with a notification, so they can be
// banned.
import React, { FC, useEffect, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { Channel } from '@gitroom/frontend/components/bolt-inbox/shared';

export const AlertWords: FC<{ channels: Channel[] }> = ({ channels }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const { data, mutate } = useSWR<Record<string, string[]>>('/inbox/alert-words', async (url: string) => (await fetch(url)).json());
  // Facebook first: that's where muted people are worth watching
  const sorted = [...channels].sort((a, b) => Number(b.identifier === 'facebook') - Number(a.identifier === 'facebook'));
  const [channel, setChannel] = useState('');
  const current = channel || sorted[0]?.id || '';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText((data?.[current] || []).join(', ')), [data, current]);

  if (!sorted.length) return null;
  const saved = (data?.[current] || []).join(', ');

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/inbox/alert-words/${current}`, { method: 'PUT', body: JSON.stringify({ words: text }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || `HTTP ${res.status}`);
      await mutate(await res.json(), { revalidate: false });
      toaster.show(t('alert_words_saved', 'Alert words saved'), 'success');
    } catch (err: any) {
      toaster.show(err?.message || t('alert_words_failed', 'Could not save'), 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="text-[12px]">
      <summary className="cursor-pointer text-[13px]">
        {t('alert_words', 'Alert words')}
        {!!Object.keys(data || {}).length && <span className="text-textItemBlur"> · {Object.keys(data || {}).length}</span>}
      </summary>
      <div className="flex flex-col gap-[6px] mt-[6px]">
        <div className="text-textItemBlur">
          {t('alert_words_help', 'A muted person who uses one of these still shows up, flagged, and you get a notification, so you can ban them.')}
        </div>
        <div className="text-textItemBlur">
          {t('alert_words_how', 'Disguises like f**k or sh!t are caught by the plain word. A word also catches longer forms (fuck → fucking); put it in quotes ("ass") to match it only on its own.')}
        </div>
        <select
          value={current}
          onChange={(e) => setChannel(e.target.value)}
          className="bg-newTableHeader border border-newTableBorder rounded-[6px] h-[30px] px-[6px] outline-none"
        >
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.identifier}){data?.[c.id]?.length ? ` · ${data[c.id].length}` : ''}
            </option>
          ))}
        </select>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={t('alert_words_placeholder', 'Words, separated by commas')}
          className="bg-newTableHeader border border-newTableBorder rounded-[6px] p-[6px] outline-none resize-y"
        />
        <button
          type="button"
          disabled={busy || text.trim() === saved}
          onClick={save}
          className="h-[28px] rounded-[6px] bg-[#612BD3] text-white disabled:opacity-50"
        >
          {t('save', 'Save')}
        </button>
      </div>
    </details>
  );
};
