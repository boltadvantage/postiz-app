'use client';

import React from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import dynamic from 'next/dynamic';
import AuthenticationComponent from '@gitroom/frontend/components/settings/authentication.component';
import TwoFactorComponent from '@gitroom/frontend/components/settings/two-factor.component';
import EmailNotificationsComponent from '@gitroom/frontend/components/settings/email-notifications.component';
import ShortlinkPreferenceComponent from '@gitroom/frontend/components/settings/shortlink-preference.component';
import DeleteAccountComponent from '@gitroom/frontend/components/settings/delete-account.component';
import XBudgetComponent from '@gitroom/frontend/components/settings/x-budget.component';
import DesktopNotificationsComponent from '@gitroom/frontend/components/settings/desktop.notifications.component';

const MetricComponent = dynamic(
  () => import('@gitroom/frontend/components/settings/metric.component'),
  {
    ssr: false,
  }
);

export const GlobalSettings = () => {
  const t = useT();
  return (
    <div className="flex flex-col">
      <h3 className="text-[20px]">{t('global_settings', 'Global Settings')}</h3>
      <AuthenticationComponent />
      <TwoFactorComponent />
      <XBudgetComponent />
      <DesktopNotificationsComponent />
      <MetricComponent />
      <EmailNotificationsComponent />
      <ShortlinkPreferenceComponent />
      <DeleteAccountComponent />
    </div>
  );
};
