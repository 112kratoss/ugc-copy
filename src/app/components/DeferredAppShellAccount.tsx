'use client';

import dynamic from 'next/dynamic';

import AppShellAccountFallback from './AppShellAccountFallback';

const AppShellAccount = dynamic(() => import('./AppShellAccount'), {
  ssr: false,
  loading: () => <AppShellAccountFallback />,
});

export default function DeferredAppShellAccount() {
  return <AppShellAccount />;
}
