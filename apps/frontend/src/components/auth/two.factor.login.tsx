'use client';

// Bolt Advantage: second sign-in step for accounts with an authenticator app.
import { FC, FormEvent, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export const TwoFactorLogin: FC<{ challenge: string; onCancel: () => void }> = ({
  challenge,
  onCancel,
}) => {
  const t = useT();
  const fetchData = useFetch();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetchData('/auth/login/2fa', {
      method: 'POST',
      body: JSON.stringify({ challenge, code }),
    });
    // success sends a reload header and the page refreshes signed in
    if (res.status !== 200) {
      setError(await res.text());
      setCode('');
      setLoading(false);
    }
  };

  return (
    <form className="flex-1 flex" onSubmit={submit}>
      <div className="flex flex-col flex-1 gap-[16px]">
        <h1 className="text-[40px] font-[500] -tracking-[0.8px] text-start">
          {t('two_factor_title', 'Two-factor sign-in')}
        </h1>
        <p className="text-[14px] text-textItemBlur">
          {useRecovery
            ? t(
                'two_factor_recovery_prompt',
                'Enter one of the recovery codes you saved when you set up two-factor. Each code works once.'
              )
            : t(
                'two_factor_code_prompt',
                'Open your authenticator app and enter the 6-digit code for Postiz.'
              )}
        </p>
        <div className="bg-newBgColorInner h-[52px] border-newTableBorder border rounded-[8px] flex items-center">
          <input
            autoFocus
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            placeholder={useRecovery ? 'xxxx-xxxx' : '123456'}
            maxLength={useRecovery ? 12 : 7}
            className="h-full bg-transparent outline-none flex-1 px-[16px] text-[20px] tracking-[4px] text-textColor"
          />
        </div>
        {!!error && <div className="text-red-400 text-[14px]">{error}</div>}
        <Button
          type="submit"
          className="rounded-[10px] !h-[52px]"
          loading={loading}
          disabled={!code.trim()}
        >
          {t('verify', 'Verify')}
        </Button>
        <div className="flex justify-between text-[14px]">
          <button
            type="button"
            className="underline hover:font-bold"
            onClick={() => {
              setUseRecovery(!useRecovery);
              setCode('');
              setError('');
            }}
          >
            {useRecovery
              ? t('two_factor_use_app', 'Use my authenticator app')
              : t('two_factor_use_recovery', 'Use a recovery code')}
          </button>
          <button
            type="button"
            className="underline hover:font-bold"
            onClick={onCancel}
          >
            {t('back', 'Back')}
          </button>
        </div>
      </div>
    </form>
  );
};
