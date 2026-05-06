import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, ExternalLink, Sparkles, UserRound } from 'lucide-react';

import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import ProfileShareButton from '@/app/components/ProfileShareButton';
import { isE2EAuthBypassEnabled } from '@/lib/e2e-auth';
import { createServiceClient } from '@/lib/server-helpers';
import { getServerAuthState } from '@/lib/supabase-server';
import { buildFallbackUsername, toEditableCreatorProfile } from '@/lib/profile';
import type { EditableCreatorProfile, ProfileApiResponse } from '@/lib/profile';
import { buildProfileApiResponse, PROFILE_SELECT_FIELDS, type ProfileRow } from '@/lib/profile-server';

function buildStarterProfile({
  userId,
  displayName,
  credits,
}: {
  userId: string;
  displayName: string;
  credits: number | null;
}): EditableCreatorProfile {
  return {
    id: userId,
    username: buildFallbackUsername(userId),
    displayName,
    bio: '',
    avatarUrl: '',
    coverUrl: '',
    websiteUrl: '',
    twitterHandle: '',
    instagramHandle: '',
    tiktokHandle: '',
    location: '',
    credits,
  };
}

export default async function ProfilePage() {
  const auth = await getServerAuthState();

  if (!auth.session?.user) {
    redirect('/login?returnUrl=/profile');
  }

  const adminSupabase = createServiceClient();
  const { data: profile, error } = await adminSupabase
    .from('profiles')
    .select(PROFILE_SELECT_FIELDS)
    .eq('id', auth.session.user.id)
    .maybeSingle();

  const shouldUseStarterProfile = !profile && (!error || isE2EAuthBypassEnabled());
  const authDisplayName =
    typeof auth.session.user.user_metadata?.name === 'string'
      ? auth.session.user.user_metadata.name
      : '';
  const initialProfile: EditableCreatorProfile | null = profile
    ? toEditableCreatorProfile(
        buildProfileApiResponse(profile as ProfileRow, auth.session.user.id) as ProfileApiResponse
      )
    : shouldUseStarterProfile
      ? buildStarterProfile({
          userId: auth.session.user.id,
          displayName: authDisplayName,
          credits: auth.credits,
        })
      : null;
  const loadError = error && !shouldUseStarterProfile ? 'Failed to load creator profile.' : null;
  const publicProfileUsername = profile?.username?.trim() ?? '';
  const publicProfilePath = publicProfileUsername
    ? `/creators/${publicProfileUsername}`
    : null;
  const publicProfileDisplayName =
    profile?.display_name?.trim() || authDisplayName || publicProfileUsername;

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-20%] h-[50%] w-[50%] rounded-full bg-purple-900/15 blur-[120px] mix-blend-screen" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[40%] w-[40%] rounded-full bg-pink-900/10 blur-[120px] mix-blend-screen" />
      </div>

      <div className="studio-shell relative z-10 py-8">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/creations"
              className="group rounded-full border border-white/5 bg-zinc-900/50 p-3 backdrop-blur-md transition-all hover:border-white/10 hover:bg-zinc-800"
            >
              <ArrowLeft className="h-5 w-5 text-zinc-400 transition-colors group-hover:text-white" />
            </Link>
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-purple-500/20 bg-purple-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-purple-200">
                <Sparkles className="h-3.5 w-3.5" />
                Creator identity
              </div>
              <h1 className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
                Profile
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-zinc-400">
                Keep your public profile separate from your private creation workspace, and control how your showcase posts point back to you.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {publicProfilePath ? (
              <Link
                href={publicProfilePath}
                className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-purple-400/25 bg-purple-500/10 px-5 py-2.5 text-sm font-medium text-purple-100 transition-all hover:border-purple-300/40 hover:bg-purple-500/15 hover:text-white"
              >
                <ExternalLink className="h-4 w-4" />
                View public profile
              </Link>
            ) : null}
            {publicProfileUsername ? (
              <ProfileShareButton
                username={publicProfileUsername}
                displayName={publicProfileDisplayName}
                className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-medium text-zinc-200 transition-all hover:border-white/20 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
              />
            ) : null}
            <Link
              href="/creations"
              className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-medium text-zinc-200 transition-all hover:border-white/20 hover:bg-white/10 hover:text-white"
            >
              <UserRound className="h-4 w-4" />
              View creations
            </Link>
          </div>
        </div>

        <CreatorProfileCard
          initialProfile={initialProfile}
          isLoading={false}
          loadError={loadError}
        />
      </div>
    </div>
  );
}
