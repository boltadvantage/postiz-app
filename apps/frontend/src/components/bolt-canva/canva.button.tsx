'use client';

// Bolt Advantage: Canva in the post editor. "New design" opens Canva's editor
// in a new tab (stock photos are picked there); Canva's return button lands on
// /canva-return, which imports the design and hands it back here. "My designs"
// brings in an existing design straight away.
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export type CanvaMedia = { id: string; path: string; name?: string };
type Status = {
  configured: boolean;
  connected: boolean;
  name: string | null;
  redirectUrl: string;
  returnUrl: string;
  sizes: Array<{ id: string; width: number; height: number; label: string }>;
};
type Design = { id: string; title: string; thumbnail: string | null; pages: number | null; updatedAt: string | null };

/** Tabs talk over this channel: the return page tells the editor what came back. */
export const CANVA_CHANNEL = 'bolt-canva';

const CanvaLogo = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#7D2AE8" />
    <path d="M15.6 15.3c-.9 1.1-2.2 1.9-3.6 1.9-2.4 0-3.9-2.1-3.9-4.7 0-3.3 2.3-6 4.8-6 1.3 0 2 .7 2 1.5 0 .9-.6 1.4-1.1 1.4-.4 0-.6-.2-.6-.5 0-.4.3-.6.3-1 0-.3-.3-.5-.7-.5-1.5 0-3 2.4-3 4.9 0 1.9 1 3.3 2.6 3.3 1.1 0 2.1-.6 2.8-1.4.2-.2.4-.2.5 0 .1.3 0 .7-.1 1.1z" fill="#fff" />
  </svg>
);

const Panel: FC<{ close: () => void; onMedia: (m: CanvaMedia[]) => void }> = ({ close, onMedia }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const t = useT();
  const { data: status, mutate } = useSWR<Status>('/bolt-canva/status', async (u: string) => (await fetch(u)).json());
  const [tab, setTab] = useState<'new' | 'mine'>('new');
  const [waiting, setWaiting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [designs, setDesigns] = useState<Design[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  // the return page (another tab) announces connections and finished designs
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CANVA_CHANNEL);
    ch.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'connected') mutate();
      if (msg.type === 'media' && msg.state && msg.state === waitingRef.current && Array.isArray(msg.media)) {
        onMedia(msg.media);
        toaster.show(t('canva_added', 'Added from Canva'), 'success');
        close();
      }
    };
    return () => ch.close();
  }, []);

  const call = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
    return body;
  };

  const connect = async () => {
    try {
      const { url } = await call('/bolt-canva/connect');
      window.open(url, '_blank');
    } catch (err: any) {
      toaster.show(err.message, 'warning');
    }
  };

  const start = async (size: string) => {
    setBusy(size);
    try {
      const r = await call('/bolt-canva/designs', { method: 'POST', body: JSON.stringify({ size }) });
      setWaiting(r.state);
      window.open(r.editUrl, '_blank');
    } catch (err: any) {
      toaster.show(err.message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  const load = useCallback(
    async (query: string, after?: string | null) => {
      try {
        const p = new URLSearchParams();
        if (query) p.set('q', query);
        if (after) p.set('continuation', after);
        const r = await call(`/bolt-canva/designs?${p}`);
        setDesigns((d) => (after ? [...(d || []), ...r.items] : r.items));
        setMore(r.continuation);
      } catch (err: any) {
        toaster.show(err.message, 'warning');
        setDesigns([]);
      }
    },
    []
  );
  useEffect(() => {
    if (tab === 'mine' && status?.connected) load(search);
  }, [tab, search, status?.connected]);

  const bring = async (d: Design) => {
    setBusy(d.id);
    try {
      const r = await call('/bolt-canva/import', { method: 'POST', body: JSON.stringify({ designId: d.id }) });
      onMedia(r.media);
      toaster.show(t('canva_added', 'Added from Canva'), 'success');
      close();
    } catch (err: any) {
      toaster.show(err.message, 'warning');
    } finally {
      setBusy(null);
    }
  };

  if (!status) return <div className="p-[20px] text-[14px]">{t('loading', 'Loading…')}</div>;

  if (!status.configured) {
    return (
      <div className="p-[20px] flex flex-col gap-[10px] text-[14px]">
        <div>{t('canva_not_configured', 'Canva isn’t set up on this server yet. Create an app in Canva’s Developer Portal and put its keys in CANVA_CLIENT_ID and CANVA_CLIENT_SECRET.')}</div>
        <div className="text-[12px] text-textItemBlur">
          {t('canva_redirect', 'Redirect URL')}: <code>{status.redirectUrl}</code>
          <br />
          {t('canva_return', 'Return URL')}: <code>{status.returnUrl}</code>
        </div>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="p-[20px] flex flex-col gap-[12px] text-[14px] items-start">
        <div>{t('canva_connect_help', 'Connect your Canva account to design posts with Canva’s stock photos and templates.')}</div>
        <button type="button" onClick={connect} className="h-[36px] px-[16px] rounded-[8px] bg-[#7D2AE8] text-white font-[600]">
          {t('canva_connect', 'Connect Canva')}
        </button>
        <div className="text-[12px] text-textItemBlur">{t('canva_connect_after', 'Canva opens in a new tab. When it says you’re connected, come back here.')}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[14px] p-[4px] text-[14px] min-h-[320px]">
      <div className="flex items-center gap-[8px]">
        {(['new', 'mine'] as const).map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTab(x)}
            className={clsx('h-[32px] px-[14px] rounded-[8px]', tab === x ? 'bg-[#7D2AE8] text-white' : 'bg-newTableHeader')}
          >
            {x === 'new' ? t('canva_new_design', 'New design') : t('canva_my_designs', 'My designs')}
          </button>
        ))}
        <span className="ms-auto text-[12px] text-textItemBlur">{status.name ? t('canva_as', 'Canva: {{name}}', { name: status.name, interpolation: { escapeValue: false } }) : null}</span>
      </div>

      {tab === 'new' && (
        <>
          <div className="text-[13px] text-textItemBlur">
            {t('canva_new_help', 'Pick a size. Canva opens in a new tab: search stock photos there and design. When you’re done, click Canva’s return button (top left) and the image comes back into this post.')}
          </div>
          <div className="grid grid-cols-2 gap-[10px]">
            {status.sizes.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={!!busy}
                onClick={() => start(s.id)}
                className="h-[64px] rounded-[10px] border border-newTableBorder hover:border-[#7D2AE8] flex items-center gap-[12px] px-[14px] disabled:opacity-50"
              >
                <span
                  className="border-2 border-current rounded-[3px] shrink-0"
                  style={{ width: Math.round((s.width / Math.max(s.width, s.height)) * 32), height: Math.round((s.height / Math.max(s.width, s.height)) * 32) }}
                />
                <span>{busy === s.id ? t('opening', 'Opening…') : s.label}</span>
              </button>
            ))}
          </div>
          {waiting && (
            <div className="rounded-[8px] bg-newTableHeader p-[12px] text-[13px]">
              {t('canva_waiting', 'Waiting for your design… Finish it in Canva and click its return button. You can also close this window: the image will still be saved in your media library.')}
            </div>
          )}
        </>
      )}

      {tab === 'mine' && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
            className="flex gap-[8px]"
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('canva_search', 'Search your Canva designs')}
              className="flex-1 bg-newTableHeader border border-newTableBorder rounded-[8px] h-[34px] px-[12px] outline-none"
            />
            <button type="submit" className="h-[34px] px-[14px] rounded-[8px] bg-newTableHeader">
              {t('search', 'Search')}
            </button>
          </form>
          {designs === null ? (
            <div className="text-textItemBlur">{t('loading', 'Loading…')}</div>
          ) : !designs.length ? (
            <div className="text-textItemBlur">{t('canva_none', 'No designs found.')}</div>
          ) : (
            <div className="grid grid-cols-3 mobile:grid-cols-2 gap-[10px] max-h-[55vh] overflow-y-auto">
              {designs.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  disabled={!!busy}
                  onClick={() => bring(d)}
                  className="flex flex-col gap-[6px] text-start rounded-[10px] border border-newTableBorder hover:border-[#7D2AE8] p-[8px] disabled:opacity-50"
                >
                  <div className="aspect-square w-full rounded-[6px] bg-newTableHeader overflow-hidden flex items-center justify-center">
                    {d.thumbnail ? <img src={d.thumbnail} alt="" className="w-full h-full object-contain" /> : <CanvaLogo />}
                  </div>
                  <div className="text-[12px] truncate">{busy === d.id ? t('canva_bringing', 'Bringing it in…') : d.title}</div>
                  {!!d.pages && d.pages > 1 && <div className="text-[11px] text-textItemBlur">{t('canva_pages', '{{n}} pages', { n: d.pages })}</div>}
                </button>
              ))}
            </div>
          )}
          {more && (
            <button type="button" onClick={() => load(search, more)} className="self-center h-[30px] px-[14px] rounded-[8px] bg-newTableHeader text-[13px]">
              {t('load_more', 'Load more')}
            </button>
          )}
        </>
      )}
    </div>
  );
};

/** The toolbar button next to Insert Media. */
export const CanvaButton: FC<{ onChange: (m: CanvaMedia[]) => void }> = ({ onChange }) => {
  const modals = useModals();
  const t = useT();
  const open = () =>
    modals.openModal({
      title: 'Canva',
      size: '720px',
      children: (close: () => void) => <Panel close={close} onMedia={onChange} />,
    });
  return (
    <div
      onClick={open}
      className="cursor-pointer h-[30px] mobile:h-[40px] mobile:min-w-[40px] rounded-[6px] mobile:rounded-[8px] justify-center items-center flex bg-newColColor mobile:bg-newSettings px-[8px]"
      title={t('canva_button', 'Design in Canva')}
    >
      <div className="flex gap-[6px] items-center">
        <CanvaLogo />
        <div className="text-[10px] font-[600] maxMedia:hidden block">Canva</div>
      </div>
    </div>
  );
};
