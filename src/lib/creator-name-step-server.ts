import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { requestHasAuthHint } from '@/components/RouteAuthBoundary';
import { isGuestUser } from '@/lib/account-identity';
import { buildCreatorNameStepPath } from '@/lib/auth-onboarding';
import {
  CREATOR_NAME_STEP_SHOWN_COOKIE,
  readCreatorNameStepShownFor,
  shouldReopenCreatorNameStep,
} from '@/lib/creator-name-step';
import { getServerAuthState, getServerPublicIdentity } from '@/lib/supabase-server';

/**
 * Home opens the creator-name step for an account without a name, once per
 * browser session (`shouldReopenCreatorNameStep`), and comes back to Home after
 * it (`/?welcome=1` once the name is saved). Decided on the server from the
 * profile read with the session, so it costs no read of its own and Home is
 * never drawn first. Throws Next's redirect when the step is due.
 */
export async function reopenCreatorNameStepFromHome(): Promise<void> {
  if (!(await requestHasAuthHint())) return;
  const auth = await getServerAuthState();
  const user = auth.session?.user;
  if (!user) return;
  const cookieStore = await cookies();
  const reopen = shouldReopenCreatorNameStep({
    identity: getServerPublicIdentity(auth),
    userId: user.id,
    userMetadata: user.user_metadata,
    isGuest: isGuestUser(user),
    shownFor: readCreatorNameStepShownFor(cookieStore.get(CREATOR_NAME_STEP_SHOWN_COOKIE)?.value),
  });
  if (reopen) redirect(buildCreatorNameStepPath('/'));
}
