import { Sparkles } from 'lucide-react';
import { redirect } from 'next/navigation';

import { loadOwnerProfile } from './load-owner-profile';
import OwnerProfileMediaHub, { type OwnerWalletBalance } from './OwnerProfileMediaHub';
import { isGuestUser } from '@/lib/account-identity';
import { buildCreatorNameStepPath, isOldProfileSetupPath } from '@/lib/auth-onboarding';
import { getCreatorPayoutState } from '@/lib/creator-payouts';
import { createServiceClient } from '@/lib/server-helpers';
import { getServerAuthState } from '@/lib/supabase-server';

interface ProfilePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Sign-in comes back to this same address, its tab, open post and `next`
// included.
function buildProfileReturnPath(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, item);
    }
  }
  const search = query.toString();
  return search ? `/profile?${search}` : '/profile';
}

// The Wallet card says what can be withdrawn: the payout balance the seller
// dashboard reads from `GET /api/creator/payouts`, read here the same way and
// for the same callers (registered accounts). A failed read leaves the card
// "Balance unavailable"; it never fails the page.
async function loadWalletBalance(): Promise<OwnerWalletBalance | null> {
  const { session } = await getServerAuthState();
  const user = session?.user;
  if (!user || isGuestUser(user)) {
    return null;
  }

  try {
    const { availableUsd } = await getCreatorPayoutState({
      adminSupabase: createServiceClient(),
      userId: user.id,
    });
    return { availableUsd };
  } catch {
    return null;
  }
}

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  // The profile drew the creations library again as a tab of its own, and
  // opened a creation from `?generation=`; both are Studio's. An address kept
  // from then (history, a bookmark) opens there.
  const legacyGenerationId = getParam(resolvedSearchParams.generation);
  if (legacyGenerationId || getParam(resolvedSearchParams.tab) === 'creations') {
    redirect(legacyGenerationId
      ? `/creations?${new URLSearchParams({ generation: legacyGenerationId })}`
      : '/creations');
  }
  const profileReturnPath = buildProfileReturnPath(resolvedSearchParams);
  // A first-profile link from before the creator-name step (a bookmark, the
  // history, Home's welcome card) opens the step, on the way to its `next`.
  if (isOldProfileSetupPath(profileReturnPath)) {
    redirect(buildCreatorNameStepPath(profileReturnPath));
  }
  const [
    {
      initialProfile,
      loadError,
      publicProfileUsername,
      publicProfilePath,
      publicProfileDisplayName,
      stats,
    },
    walletBalance,
  ] = await Promise.all([
    loadOwnerProfile(profileReturnPath, { includeTotals: true }),
    loadWalletBalance(),
  ]);

  return (
    <div className="ui-page ui-page-ambient min-h-screen">
      <div className="studio-shell relative z-10 py-7 sm:py-9">
        {/* The page's name on a phone too, where the top bar no longer gives
            one: the kicker and the line under it from 640px only. */}
        <header className="ui-enter mb-5 sm:mb-7">
          <div className="mb-3 hidden items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)] sm:inline-flex">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Creator account
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--ui-text-primary)] sm:text-4xl">
            Profile
          </h1>
          <p className="mt-2 hidden max-w-2xl text-sm leading-6 text-zinc-400 sm:block">
            Your identity, creator account, and published work in one place.
          </p>
        </header>

        {/* No setup mode of its own: a new account chooses its creator name at
            /onboarding, and Edit profile changes it afterwards. */}
        {initialProfile ? (
          <OwnerProfileMediaHub
            creator={{
              id: initialProfile.id,
              username: publicProfileUsername || null,
              name: initialProfile.displayName || publicProfileDisplayName || 'Creator',
              avatar: initialProfile.avatarUrl || null,
            }}
            profile={{
              bio: initialProfile.bio,
              coverUrl: initialProfile.coverUrl || null,
              credits: initialProfile.credits,
            }}
            stats={stats}
            walletBalance={walletBalance}
            publicProfilePath={publicProfilePath}
            publicProfileDisplayName={publicProfileDisplayName}
          />
        ) : (
          <div role="alert" className="rounded-3xl border border-red-500/20 bg-red-500/5 p-6 text-sm text-red-200">
            {loadError || 'Your profile could not be loaded.'}
          </div>
        )}
      </div>
    </div>
  );
}
