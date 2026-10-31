import { redirect } from 'next/navigation';

import { getSellerPostResourceBundleDashboard } from '@/lib/post-resource-bundles-server';
import { getServerAuthState } from '@/lib/supabase-server';

import MarketplaceSellClient from './MarketplaceSellClient';

export default async function MarketplaceSellPage() {
  const auth = await getServerAuthState();
  if (!auth.session?.user) {
    redirect('/login?returnUrl=/marketplace/sell');
  }

  // No country: the page prices in credits, and a buyer's cash quote for
  // each recipe would only cost a currency read.
  const dashboard = await getSellerPostResourceBundleDashboard(auth.session.user.id);

  return (
    <MarketplaceSellClient
      initialDashboard={dashboard}
    />
  );
}
