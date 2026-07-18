import { BadgeCheck, CheckCircle2, Sparkles } from 'lucide-react';

import DeferredCreatorProfileCard from './DeferredCreatorProfileCard';
import { loadOwnerProfile } from './load-owner-profile';
import OwnerProfileMediaHub from './OwnerProfileMediaHub';
import { getSafeProfileNextPath } from '@/lib/profile';

interface ProfilePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

function getParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const requestedNextPath = getParam(resolvedSearchParams.next);
  const nextPath = getSafeProfileNextPath(requestedNextPath);
  const profileReturnPath = `/profile?next=${encodeURIComponent(nextPath)}`;
  const {
    initialProfile,
    loadError,
    readiness,
    publicProfileUsername,
    publicProfilePath,
    publicProfileDisplayName,
  } = await loadOwnerProfile(profileReturnPath);
  const isFirstRunProfile = !readiness.publicPublishReady;
  const setupSteps = [
    {
      label: 'Claim handle',
      done: readiness.hasClaimedHandle,
      detail: readiness.hasClaimedHandle
        ? `@${publicProfileUsername}`
        : 'Choose a custom handle for your public URL',
    },
    {
      label: 'Add your name',
      done: readiness.hasDisplayName,
      detail: 'Required before you publish publicly',
    },
    {
      label: 'Add an avatar',
      done: readiness.hasAvatar,
      detail: 'Recommended now and required before selling recipes',
    },
  ];

  return (
    <div className="ui-page ui-page-ambient min-h-screen">
      <div className="studio-shell relative z-10 py-7 sm:py-9">
        <header className="ui-enter mb-7 hidden sm:block">
          <div className="mb-3 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)]">
            <Sparkles className="h-3.5 w-3.5" aria-hidden />
            Creator account
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ui-text-primary)] sm:text-4xl">
            {isFirstRunProfile ? 'Set up your creator profile' : 'Profile'}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            {isFirstRunProfile
              ? 'Choose the identity your public posts will point to. Optional details can wait.'
              : 'Your identity, creator account, and published work in one place.'}
          </p>
        </header>

        {isFirstRunProfile ? (
          <>
            <section className="mb-7 rounded-[28px] border border-[rgba(255,122,89,0.2)] bg-[var(--ui-surface-1)] p-5 shadow-[var(--ui-shadow-panel)] sm:p-6">
              <div className="max-w-2xl">
                <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,122,89,0.24)] bg-[var(--ui-primary-soft)] px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary-strong)]">
                  <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                  Profile setup
                </div>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  Claim the identity your posts and recipes will point to
                </h2>
                <p className="mt-3 max-w-xl text-sm leading-7 text-zinc-300">
                  Start with a handle and display name. An avatar builds trust; your bio, cover, links, and location can wait.
                </p>
              </div>
              <div className="mt-6 grid gap-3 md:grid-cols-3">
                {setupSteps.map((step) => (
                  <div
                    key={step.label}
                    className={`rounded-[22px] border p-4 ${step.done
                      ? 'border-emerald-300/20 bg-emerald-500/10'
                      : 'border-white/8 bg-white/[0.03]'}`}
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-white">
                      <CheckCircle2 className={`h-4 w-4 ${step.done ? 'text-emerald-300' : 'text-zinc-500'}`} aria-hidden />
                      {step.label}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-zinc-400">{step.detail}</p>
                  </div>
                ))}
              </div>
            </section>

            <DeferredCreatorProfileCard
              initialProfile={initialProfile}
              isLoading={false}
              loadError={loadError}
              onboardingMode
              nextPath={nextPath}
              returnAfterSave={Boolean(requestedNextPath)}
            />
          </>
        ) : initialProfile ? (
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
