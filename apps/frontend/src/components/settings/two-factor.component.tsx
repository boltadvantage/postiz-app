'use client';

// Bolt Advantage: turn authenticator-app sign-in on or off.
import React, { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

interface Status {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

type Mode = 'idle' | 'password' | 'setup' | 'codes' | 'disable' | 'regenerate';

const btn = 'rounded-[8px] !h-[36px] !px-[16px] text-[14px] whitespace-nowrap shrink-0';
const btnSecondary = `${btn} border border-newTableBorder !bg-transparent hover:!bg-newBgColorInner`;
const btnDanger = `${btn} !bg-red-800`;

const CodeInput = ({
  value,
  onChange,
  placeholder = '123456',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) => (
  <div className="bg-newBgColorInner h-[42px] border-newTableBorder border rounded-[8px] flex items-center w-[200px]">
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder={placeholder}
      maxLength={12}
      className="h-full bg-transparent outline-none flex-1 px-[16px] text-[16px] tracking-[3px] text-textColor"
    />
  </div>
);

const TwoFactorComponent = () => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const [mode, setMode] = useState<Mode>('idle');
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => (await fetch('/user/2fa')).json(), []);
  const { data, mutate } = useSWR<Status>('two-factor-status', load, {
    revalidateOnFocus: false,
  });

  const call = useCallback(
    async (path: string, method = 'POST', body?: object) => {
      setBusy(true);
      setError('');
      const res = await fetch(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setBusy(false);
      if (res.status >= 400) {
        const text = await res.text();
        try {
          setError(JSON.parse(text).message || text);
        } catch {
          setError(text);
        }
        return null;
      }
      return res.json();
    },
    []
  );

  const reset = () => {
    setMode('idle');
    setCode('');
    setError('');
    setSetup(null);
  };

  const startSetup = async () => {
    const res = await call('/user/2fa/setup', 'POST', { password });
    setPassword('');
    if (res) {
      setSetup(res);
      setMode('setup');
    }
  };

  const cancelSetup = async () => {
    await call('/user/2fa/setup', 'DELETE');
    reset();
  };

  const confirmSetup = async () => {
    const res = await call('/user/2fa/enable', 'POST', { code });
    if (res) {
      setRecoveryCodes(res.recoveryCodes);
      setSetup(null);
      setCode('');
      setMode('codes');
      mutate();
      toaster.show(t('two_factor_enabled', 'Two-factor sign-in is on'), 'success');
    }
  };

  const regenerate = async () => {
    const res = await call('/user/2fa/recovery-codes', 'POST', { code });
    if (res) {
      setRecoveryCodes(res.recoveryCodes);
      setCode('');
      setMode('codes');
      mutate();
    }
  };

  const disable = async () => {
    const res = await call('/user/2fa/disable', 'POST', { code });
    if (res) {
      reset();
      mutate();
      toaster.show(t('two_factor_disabled', 'Two-factor sign-in is off'), 'warning');
    }
  };

  const downloadCodes = () => {
    const blob = new Blob(
      [
        `Postiz recovery codes (${window.location.host})\n` +
          'Each code works once. Keep them somewhere safe.\n\n' +
          recoveryCodes.join('\n') +
          '\n',
      ],
      { type: 'text/plain' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'postiz-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!data) {
    return null;
  }

  return (
    <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[16px]">
      <div className="flex items-center justify-between gap-[24px]">
        <div className="flex-1 min-w-0">
          <div>{t('two_factor_title', 'Two-factor sign-in')}</div>
          <div className="text-[14px] text-textItemBlur mt-[4px]">
            {data.enabled
              ? t(
                  'two_factor_on_status',
                  'On. Signing in asks for a code from your authenticator app. Recovery codes left: {{count}}',
                  { count: data.recoveryCodesLeft }
                )
              : t(
                  'two_factor_off_status',
                  'Off. Add a code from an authenticator app (1Password, Google Authenticator, Authy) to every sign-in.'
                )}
          </div>
        </div>
        {mode === 'idle' &&
          (data.enabled ? (
            <div className="flex gap-[8px] shrink-0">
              <Button className={btnSecondary} secondary onClick={() => setMode('regenerate')}>
                {t('two_factor_new_codes', 'New recovery codes')}
              </Button>
              <Button className={btnDanger} onClick={() => setMode('disable')}>
                {t('turn_off', 'Turn off')}
              </Button>
            </div>
          ) : (
            <Button className={btn} onClick={() => setMode('password')}>
              {t('set_up', 'Set up')}
            </Button>
          ))}
      </div>

      {mode === 'setup' && setup && (
        <div className="flex gap-[24px] flex-wrap">
          <img
            src={setup.qr}
            alt="QR code for your authenticator app"
            className="w-[180px] h-[180px] rounded-[8px] bg-white p-[6px]"
          />
          <div className="flex flex-col gap-[12px] flex-1 min-w-[260px] text-[14px]">
            <div>
              {t(
                'two_factor_scan',
                '1. Scan this QR code with your authenticator app. If you can’t scan it, enter this key by hand:'
              )}
            </div>
            <code className="select-all break-all bg-newBgColorInner border border-newTableBorder rounded-[6px] px-[10px] py-[6px] tracking-[2px]">
              {setup.secret.match(/.{1,4}/g)?.join(' ')}
            </code>
            <div>{t('two_factor_enter_code', '2. Enter the 6-digit code the app shows:')}</div>
            <div className="flex gap-[8px] items-center">
              <CodeInput value={code} onChange={setCode} />
              <Button className={btn} loading={busy} disabled={!code.trim()} onClick={confirmSetup}>
                {t('turn_on', 'Turn on')}
              </Button>
              <Button className={btnSecondary} secondary onClick={cancelSetup}>
                {t('cancel', 'Cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {mode === 'codes' && (
        <div className="flex flex-col gap-[12px] text-[14px]">
          <div className="text-amber-400">
            {t(
              'two_factor_save_codes',
              'Save these recovery codes now. They won’t be shown again. Each one signs you in once if you lose your phone.'
            )}
          </div>
          <div className="grid grid-cols-2 gap-[6px] w-fit font-mono select-all bg-newBgColorInner border border-newTableBorder rounded-[6px] p-[12px]">
            {recoveryCodes.map((c) => (
              <div key={c} className="px-[8px]">
                {c}
              </div>
            ))}
          </div>
          <div className="flex gap-[8px]">
            <Button className={btn} onClick={downloadCodes}>
              {t('download', 'Download')}
            </Button>
            <Button
              className={btnSecondary}
              secondary
              onClick={() => {
                setRecoveryCodes([]);
                reset();
              }}
            >
              {t('two_factor_saved_them', 'I saved them')}
            </Button>
          </div>
        </div>
      )}

      {mode === 'password' && (
        <div className="flex flex-col gap-[12px] text-[14px]">
          <div>{t('two_factor_confirm_password', 'Enter your current password to set up the authenticator app.')}</div>
          <form
            className="flex gap-[8px] items-center"
            onSubmit={(e) => {
              e.preventDefault();
              if (password) startSetup();
            }}
          >
            <div className="bg-newBgColorInner h-[42px] border-newTableBorder border rounded-[8px] flex items-center w-[240px]">
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('password', 'Password')}
                className="h-full bg-transparent outline-none flex-1 px-[16px] text-[16px] text-textColor"
              />
            </div>
            <Button type="submit" className={btn} loading={busy} disabled={!password}>
              {t('continue', 'Continue')}
            </Button>
            <Button className={btnSecondary} secondary onClick={() => (setPassword(''), reset())}>
              {t('cancel', 'Cancel')}
            </Button>
          </form>
        </div>
      )}

      {(mode === 'disable' || mode === 'regenerate') && (
        <div className="flex flex-col gap-[12px] text-[14px]">
          <div>
            {mode === 'disable'
              ? t('two_factor_confirm_disable', 'Enter a code from your app (or a recovery code) to turn two-factor off.')
              : t('two_factor_confirm_regenerate', 'Enter a code from your app to replace your recovery codes. The old ones stop working.')}
          </div>
          <div className="flex gap-[8px] items-center">
            <CodeInput value={code} onChange={setCode} />
            <Button
              className={mode === 'disable' ? btnDanger : btn}
              loading={busy}
              disabled={!code.trim()}
              onClick={mode === 'disable' ? disable : regenerate}
            >
              {mode === 'disable' ? t('turn_off', 'Turn off') : t('two_factor_new_codes', 'New recovery codes')}
            </Button>
            <Button className={btnSecondary} secondary onClick={reset}>
              {t('cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      {!!error && <div className="text-red-400 text-[14px]">{error}</div>}
    </div>
  );
};

export default TwoFactorComponent;
