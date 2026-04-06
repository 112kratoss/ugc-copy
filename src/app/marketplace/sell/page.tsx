import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getSellerMarketplaceDashboard } from '@/lib/marketplace-server';
import { getServerAuthState } from '@/lib/supabase-server';

import MarketplaceSellClient from './MarketplaceSellClient';

interface MarketplaceSellPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function MarketplaceSellPage({ searchParams }: MarketplaceSellPageProps) {
  const auth = await getServerAuthState();
  if (!auth.session?.user) {
    redirect('/login?returnUrl=/marketplace/sell');
  }

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const selectedPostId = Array.isArray(resolvedSearchParams.postId)
    ? resolvedSearchParams.postId[0] ?? null
    : resolvedSearchParams.postId ?? null;
  const headerStore = await headers();
  const dashboard = await getSellerMarketplaceDashboard(auth.session.user.id, {
    countryCode: headerStore.get('x-vercel-ip-country'),
  });

  return (
    <MarketplaceSellClient
      initialDashboard={dashboard}
      initialSelectedPostId={selectedPostId}
    />
  );
}
