import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getSellerPostResourceBundleDashboard } from '@/lib/post-resource-bundles-server';
import { getServerAuthState } from '@/lib/supabase-server';

import MarketplaceSellClient from './MarketplaceSellClient';

export default async function MarketplaceSellPage() {
  const auth = await getServerAuthState();
  if (!auth.session?.user) {
    redirect('/login?returnUrl=/marketplace/sell');
  }

  const headerStore = await headers();
  const dashboard = await getSellerPostResourceBundleDashboard(auth.session.user.id, {
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  return (
    <MarketplaceSellClient
      initialDashboard={dashboard}
    />
  );
}
