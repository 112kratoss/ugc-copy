import 'server-only';

import { redirect } from 'next/navigation';

import { isE2EAuthBypassEnabled } from '@/lib/e2e-auth';
import {
  buildFallbackUsername,
  getAuthAvatarUrl,
  getCreatorDisplayName,
  getCreatorProfileReadiness,
  toEditableCreatorProfile,
} from '@/lib/profile';
import type { EditableCreatorProfile, ProfileApiResponse } from '@/lib/profile';
import { buildProfileApiResponse, PROFILE_SELECT_FIELDS, type ProfileRow } from '@/lib/profile-server';
import { createServiceClient } from '@/lib/server-helpers';
import { getServerAuthState } from '@/lib/supabase-server';

function buildStarterProfile({
  userId,
  displayName,
  avatarUrl,
  credits,
}: {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  credits: number | null;
}): EditableCreatorProfile {
  return {
    id: userId,
    username: buildFallbackUsername(userId),
    displayName,
    bio: '',
    avatarUrl: avatarUrl ?? '',
    coverUrl: '',
    websiteUrl: '',
    twitterHandle: '',
    instagramHandle: '',
    tiktokHandle: '',
    location: '',
    credits,
  };
}

export async function loadOwnerProfile(returnPath: string) {
  const auth = await getServerAuthState();

  if (!auth.session?.user) {
    redirect(`/login?returnUrl=${encodeURIComponent(returnPath)}`);
  }

  const user = auth.session.user;
  const adminSupabase = createServiceClient();
  const { data: profile, error } = await adminSupabase
    .from('profiles')
    .select(PROFILE_SELECT_FIELDS)
    .eq('id', user.id)
    .maybeSingle();

  const shouldUseStarterProfile = !profile && (!error || isE2EAuthBypassEnabled());
  const authDisplayName =
    typeof user.user_metadata?.name === 'string'
      ? user.user_metadata.name
      : typeof user.user_metadata?.full_name === 'string'
        ? user.user_metadata.full_name
        : '';
  const authAvatarUrl = getAuthAvatarUrl(user.user_metadata);
  const initialProfile: EditableCreatorProfile | null = profile
    ? (() => {
        const persistedProfile = buildProfileApiResponse(
          profile as ProfileRow,
          user.id
        ) as ProfileApiResponse;

        return toEditableCreatorProfile({
          ...persistedProfile,
          displayName: persistedProfile.displayName || authDisplayName || null,
          avatarUrl: persistedProfile.avatarUrl || authAvatarUrl,
        });
      })()
    : shouldUseStarterProfile
      ? buildStarterProfile({
          userId: user.id,
          displayName: getCreatorDisplayName({
            displayName: authDisplayName,
            email: user.email ?? null,
          }),
          avatarUrl: authAvatarUrl,
          credits: auth.credits,
        })
      : null;

  const readiness = getCreatorProfileReadiness(initialProfile);
  const publicProfileUsername = readiness.hasClaimedHandle
    ? profile?.username?.trim() ?? ''
    : '';

  return {
    initialProfile,
    loadError: error && !shouldUseStarterProfile ? 'Failed to load creator profile.' : null,
    readiness,
    publicProfileUsername,
    publicProfilePath: publicProfileUsername ? `/creators/${publicProfileUsername}` : null,
    publicProfileDisplayName:
      profile?.display_name?.trim() || authDisplayName || publicProfileUsername,
  };
}
