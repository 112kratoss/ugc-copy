import { redirect } from 'next/navigation';

import { isGuestUser } from '@/lib/account-identity';
import { buildCreatorNameStepPath, creatorNameStepNextPath } from '@/lib/auth-onboarding';
import { startCreatorNameStep } from '@/lib/creator-name-step';
import { getCreatorProfileReadiness } from '@/lib/profile';
import { getServerAuthState, getServerPublicIdentity } from '@/lib/supabase-server';
import CreatorNameStep from './CreatorNameStep';

interface CreatorNameStepPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/onboarding?next=`: the creator name a new account chooses before anything
 * else (owner, 2026-11-09, the app's identity stage on the web). A signed-out
 * visitor signs in first and comes back here; an account that already has its
 * name and handle goes straight on to `next`.
 */
export default async function CreatorNameStepPage({ searchParams }: CreatorNameStepPageProps) {
  const params = searchParams ? await searchParams : {};
  const nextPath = creatorNameStepNextPath(firstParam(params.next));
  const auth = await getServerAuthState();
  const user = auth.session?.user;
  if (!user || isGuestUser(user)) {
    redirect(`/login?returnUrl=${encodeURIComponent(buildCreatorNameStepPath(nextPath))}`);
  }

  // Read with the session (`getServerAuthState`); null when the row was not,
  // and then the save reads it again before writing (`claimPublicIdentity`).
  const identity = getServerPublicIdentity(auth);
  if (identity && getCreatorProfileReadiness(identity).publicPublishReady) {
    redirect(nextPath);
  }

  return (
    <CreatorNameStep
      nextPath={nextPath}
      userId={user.id}
      savedUsername={identity?.username ?? null}
      start={startCreatorNameStep(identity, user)}
    />
  );
}
