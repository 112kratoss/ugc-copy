import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  getSafeReferralDestination,
  normalizeReferralCode,
} from '@/lib/referral';

import ReferralLandingClient from './ReferralLandingClient';

export const metadata: Metadata = {
  title: 'Your Magic Booklet invite',
  description: 'Get bonus credits when you join Magic Booklet through an eligible invite.',
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

  return (
    <ReferralLandingClient code={code} destination={destination} />
  );
}
