import { useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth';
import { profileQueryKey } from '@/lib/profile-stats';
import { claimPublicIdentity, type PublicIdentityDraft } from '@/lib/public-identity';
import type { ProfileResponse } from '@/lib/types';
import { invalidateWelcomeCredits } from '@/lib/use-onboarding-destination';

/**
 * The name-and-handle claim (`claimPublicIdentity`) with what has to follow
 * it, for every place that asks for the two: the composer's step 2 and the
 * sheet a list opens when a post is made public.
 *
 * - The saved profile is merged into the account's cached one, not put in its
 *   place: the save's answer has no stats or sales totals, which the profile
 *   header and the seller total read from the same entry.
 * - The welcome card stops asking for the identity, and the account's own
 *   profile is read again, as Edit profile does after the same save.
 *
 * Throws what the save throws; `readPublicIdentitySaveError` says what it means.
 */
export function useClaimPublicIdentity() {
  const { api, user, refreshProfile } = useAuth();
  const queryClient = useQueryClient();

  return async (draft: PublicIdentityDraft): Promise<ProfileResponse> => {
    const saved = await claimPublicIdentity(api, draft);
    queryClient.setQueryData<ProfileResponse>(profileQueryKey(user?.id), (cached) => (cached ? { ...cached, ...saved } : saved));
    void invalidateWelcomeCredits(queryClient);
    void refreshProfile();
    return saved;
  };
}
