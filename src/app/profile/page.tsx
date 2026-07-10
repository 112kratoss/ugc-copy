import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, BadgeCheck, CheckCircle2, ExternalLink, Sparkles, UserRound } from 'lucide-react';

import ProfileShareButton from '@/app/components/ProfileShareButton';
import DeferredCreatorProfileCard from './DeferredCreatorProfileCard';
import { isE2EAuthBypassEnabled } from '@/lib/e2e-auth';
import { createServiceClient } from '@/lib/server-helpers';
import { getServerAuthState } from '@/lib/supabase-server';
import { buildFallbackUsername, getAuthAvatarUrl, getCreatorDisplayName, toEditableCreatorProfile } from '@/lib/profile';
import type { EditableCreatorProfile, ProfileApiResponse } from '@/lib/profile';
import { buildProfileApiResponse, PROFILE_SELECT_FIELDS, type ProfileRow } from '@/lib/profile-server';

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

interface ProfilePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
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
      : typeof auth.session.user.user_metadata?.full_name === 'string'
        ? auth.session.user.user_metadata.full_name
        : '';
  const authAvatarUrl = getAuthAvatarUrl(auth.session.user.user_metadata);
  const initialProfile: EditableCreatorProfile | null = profile
    ? toEditableCreatorProfile(
        buildProfileApiResponse(profile as ProfileRow, auth.session.user.id) as ProfileApiResponse
      )
    : shouldUseStarterProfile
      ? buildStarterProfile({
          userId: auth.session.user.id,
          displayName: getCreatorDisplayName({
            displayName: authDisplayName,
            email: auth.session.user.email ?? null,
          }),
          avatarUrl: authAvatarUrl,
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
  const isFirstRunProfile = !publicProfileUsername || getParam(resolvedSearchParams.welcome) === '1';
  const setupSteps = [
    {
      label: 'Claim handle',
      done: Boolean(publicProfileUsername),
      detail: publicProfileUsername ? `@${publicProfileUsername}` : 'Required for your public profile URL',
    },
    {
      label: 'Add identity',
      done: Boolean(initialProfile?.displayName?.trim() && initialProfile?.bio?.trim()),
      detail: 'Name and short bio help buyers recognize your work',
    },
    {
      label: 'Add proof',
      done: Boolean(initialProfile?.avatarUrl || initialProfile?.coverUrl),
      detail: 'Avatar or cover image makes the profile feel credible',
    },
  ];

  return (
    <div className="ui-page ui-page-ambient min-h-screen">
      <div className="studio-shell relative z-10 py-8">
        <div className="ui-enter mb-8 flex flex-col gap-4 border-b border-[var(--ui-border-subtle)] pb-7 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/creations"
              className="ui-focus-ring group flex h-12 w-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] transition hover:bg-[var(--ui-surface-3)]"
            >
              <ArrowLeft className="h-5 w-5 text-zinc-400 transition-colors group-hover:text-white" />
            </Link>
            <div>
              <div className="mb-3 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)]">
                <Sparkles className="h-3.5 w-3.5" />
                Creator identity
              </div>
              <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
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
                className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 self-start rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
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

        {isFirstRunProfile ? (
          <section className="mb-8 rounded-[28px] border border-[rgba(255,122,89,0.2)] bg-[var(--ui-surface-1)] p-5 shadow-[var(--ui-shadow-panel)] sm:p-6">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,122,89,0.24)] bg-[var(--ui-primary-soft)] px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary-strong)]">
                <BadgeCheck className="h-3.5 w-3.5" />
                Profile setup
              </div>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                Claim the identity your posts and unlocks will point to
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-7 text-zinc-300">
                Start with the handle. The rest can improve over time, but the public URL should be ready before you share posts or sell unlocks.
              </p>
            </div>
            <div className="mt-6 grid gap-3 md:grid-cols-3">
              {setupSteps.map((step) => (
                <div
                  key={step.label}
                  className={`rounded-[22px] border p-4 ${
                    step.done
                      ? 'border-emerald-300/20 bg-emerald-500/10'
                      : 'border-white/8 bg-white/[0.03]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <CheckCircle2 className={`h-4 w-4 ${step.done ? 'text-emerald-300' : 'text-zinc-500'}`} />
                    {step.label}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">{step.detail}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <DeferredCreatorProfileCard
          initialProfile={initialProfile}
          isLoading={false}
          loadError={loadError}
          onboardingMode={isFirstRunProfile}
        />
      </div>
    </div>
  );
}
