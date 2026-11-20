'use client';

// Bolt Advantage: where Canva sends the browser back — after connecting, or
// from the editor's return button. Imports the design and tells the post
// editor (in the other tab) what came back.
import React, { FC, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useMediaDirectory } from '@gitroom/react/helpers/use.media.directory';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { CANVA_CHANNEL, CanvaMedia } from '@gitroom/frontend/components/bolt-canva/canva.button';

const tell = (msg: unknown) => {
  try {
    const ch = new BroadcastChannel(CANVA_CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch {
    // older browsers: the image is still in the media library
  }
};

export const CanvaReturn: FC = () => {
  const params = useSearchParams();
  const fetch = useFetch();
  const media = useMediaDirectory();
  const t = useT();
  const [state, setState] = useState<{ kind: 'working' | 'connected' | 'done' | 'error'; text?: string; items?: CanvaMedia[] }>({ kind: 'working' });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const error = params.get('error');
    const token = params.get('correlation_jwt');
    if (error) return setState({ kind: 'error', text: error });
    if (params.get('connected')) {
      tell({ type: 'connected' });
      return setState({ kind: 'connected' });
    }
    if (!token) return setState({ kind: 'error', text: t('canva_return_nothing', 'Nothing came back from Canva.') });
    (async () => {
      try {
        const res = await fetch('/bolt-canva/return', { method: 'POST', body: JSON.stringify({ token }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
        tell({ type: 'media', state: body.state, media: body.media });
        setState({ kind: 'done', items: body.media });
        // a tab the editor opened can close itself
        setTimeout(() => window.close(), 2500);
      } catch (err: any) {
        setState({ kind: 'error', text: err?.message || String(err) });
      }
    })();
  }, []);

  return (
    <div className="bg-newBgColorInner flex-1 flex items-center justify-center p-[40px]">
      <div className="max-w-[520px] flex flex-col gap-[14px] items-center text-center text-[15px]">
        {state.kind === 'working' && <div>{t('canva_bringing', 'Bringing your design in from Canva…')}</div>}
        {state.kind === 'connected' && (
          <>
            <div className="text-[18px] font-[600]">{t('canva_connected', 'Canva is connected')}</div>
            <div className="text-textItemBlur">{t('canva_connected_next', 'You can close this tab and go back to your post.')}</div>
          </>
        )}
        {state.kind === 'done' && (
          <>
            <div className="text-[18px] font-[600]">{t('canva_done', 'Added to Postiz')}</div>
            <div className="flex flex-wrap gap-[8px] justify-center">
              {(state.items || []).map((m) => (
                <img key={m.id} src={media.set(m.path)} alt="" className="w-[120px] h-[120px] object-cover rounded-[8px]" />
              ))}
            </div>
            <div className="text-textItemBlur">
              {t('canva_done_next', 'It’s in your post if the editor is still open, and always in your media library. You can close this tab.')}
            </div>
          </>
        )}
        {state.kind === 'error' && (
          <>
            <div className="text-[18px] font-[600]">{t('canva_failed', 'Canva didn’t come through')}</div>
            <div className="text-textItemBlur break-words">{state.text}</div>
          </>
        )}
      </div>
    </div>
  );
};
