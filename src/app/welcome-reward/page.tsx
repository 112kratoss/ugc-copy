import { redirect } from 'next/navigation';

import { getSafeProfileNextPath } from '@/lib/profile';
import { REFERRAL_CLAIM_STATUS_PARAM } from '@/lib/referral-claim-copy';
import { getServerAuthState } from '@/lib/supabase-server';
import { welcomeRewardDestination, welcomeRewardSignInReturn } from '@/lib/welcome-reward-redirect';

interface WelcomeRewardPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The old welcome page, kept for its links (a sign-in that started from one, a
 * bookmark): the welcome credits are claimed in the popup now (owner,
 * 2026-11-09), so this only sends a signed-in account on to its `next`, where
 * the popup offers them. A visitor signs in first and comes back here.
 */
export default async function WelcomeRewardPage({ searchParams }: WelcomeRewardPageProps) {
  const resolved = searchParams ? await searchParams : {};
  const nextPath = getSafeProfileNextPath(firstParam(resolved.next), '/create');
  const referral = firstParam(resolved[REFERRAL_CLAIM_STATUS_PARAM]);
  const auth = await getServerAuthState();
  if (!auth.session?.user) {
    redirect(`/login?returnUrl=${encodeURIComponent(welcomeRewardSignInReturn(nextPath, referral))}`);
  }
  redirect(welcomeRewardDestination(nextPath, referral));
}
