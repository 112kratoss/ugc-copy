import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  getReferralStoreUrls,
  getSafeReferralDestination,
  normalizeReferralCode,
} from '@/lib/referral';

import ReferralLandingClient from './ReferralLandingClient';

export const metadata: Metadata = {
  title: 'Your Magicbooklet invite',
  description: 'Get bonus credits when you join Magicbooklet through an eligible invite.',
  robots: { index: false, follow: false },
};

export default async function ReferralLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const [{ code: rawCode }, query] = await Promise.all([params, searchParams]);
  const code = normalizeReferralCode(rawCode);
  if (!code) notFound();

  const rawDestination = Array.isArray(query.next) ? query.next[0] : query.next;
  const destination = getSafeReferralDestination(rawDestination, '/create');
  const stores = getReferralStoreUrls();

  return (
    <ReferralLandingClient
      appStoreUrl={stores.appStore}
      code={code}
      destination={destination}
      playStoreUrl={stores.playStore}
    />
  );
}
