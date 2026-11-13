'use client';

// Bolt Advantage: turn desktop notifications on for this browser and pick which ones.
import React, { useEffect, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { DEFAULT_PREFS, notify, NotifyPrefs, readPrefs, savePrefs } from '@gitroom/frontend/components/bolt-notify/desktop.notifier';

const btn = 'rounded-[8px] !h-[36px] !px-[16px] text-[14px] whitespace-nowrap shrink-0';

const DesktopNotificationsComponent = () => {
  const t = useT();
  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULT_PREFS);
  const [permission, setPermission] = useState<string>('default');

  useEffect(() => {
    setPrefs(readPrefs());
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, []);

  const update = (p: Partial<NotifyPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    savePrefs(next);
  };
  const turnOn = async () => {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === 'granted') update({ enabled: true });
  };

  const options: [keyof NotifyPrefs, string, string][] = [
    ['failures', 'notify_failures', 'A post failed'],
    ['mentions', 'notify_mentions', 'New mentions and comments'],
    ['messages', 'notify_messages', 'New messages'],
    ['follows', 'notify_follows', 'New followers'],
    ['sound', 'notify_sound', 'Play a sound'],
  ];

  return (
    <div className="my-[16px] mt-[16px] bg-sixth border-fifth border rounded-[4px] p-[24px] flex flex-col gap-[16px]">
      <div>
        <div>{t('desktop_notifications', 'Desktop notifications')}</div>
        <div className="text-[14px] text-textItemBlur mt-[4px]">
          {t(
            'desktop_notifications_help',
            'Pop-ups on this computer while Postiz is open in a tab (it can be in the background). Checked every minute. Set for this browser only.'
          )}
        </div>
      </div>
      {permission === 'unsupported' ? (
        <div className="text-[14px] text-textItemBlur">{t('notifications_unsupported', 'This browser doesn’t support notifications.')}</div>
      ) : permission === 'denied' ? (
        <div className="text-[14px] text-red-400">
          {t('notifications_denied', 'Notifications are blocked for this site. Allow them in the browser’s site settings (the icon left of the address), then reload.')}
        </div>
      ) : permission !== 'granted' || !prefs.enabled ? (
        <div>
          <Button className={btn} onClick={turnOn}>
            {t('turn_on_notifications', 'Turn on desktop notifications')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-[8px] text-[14px]">
            {options.map(([key, tKey, label]) => (
              <label key={key} className="flex items-center gap-[8px] cursor-pointer">
                <input type="checkbox" checked={!!prefs[key]} onChange={(e) => update({ [key]: e.target.checked })} />
                {t(tKey, label)}
              </label>
            ))}
          </div>
          <div className="text-[13px] text-textItemBlur">
            {t(
              'notifications_mac_help',
              'On a Mac, also check System Settings → Notifications → your browser: allow notifications and “Play sound for notifications”.'
            )}
          </div>
          <div className="flex gap-[8px]">
            <Button className={btn} onClick={() => notify('Postiz', t('notifications_test_body', 'Desktop notifications are working.'), '/settings', 'bolt-test', prefs.sound)}>
              {t('send_test', 'Send a test')}
            </Button>
            <Button className={`${btn} !bg-transparent border border-newTableBorder`} onClick={() => update({ enabled: false })}>
              {t('turn_off', 'Turn off')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default DesktopNotificationsComponent;
