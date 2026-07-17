import Link from 'next/link';
import { ArrowLeft, Sparkles } from 'lucide-react';

import DeferredCreatorProfileCard from '../DeferredCreatorProfileCard';
import { loadOwnerProfile } from '../load-owner-profile';

export default async function EditProfilePage() {
  const { initialProfile, loadError } = await loadOwnerProfile('/profile/edit');

  return (
    <div className="ui-page ui-page-ambient min-h-screen">
      <div className="studio-shell relative z-10 py-7 sm:py-9">
        <header className="ui-enter mb-7 flex items-start gap-4 border-b border-[var(--ui-border-subtle)] pb-6">
          <Link
            href="/profile"
            aria-label="Back to profile"
            className="ui-focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-zinc-300 transition hover:bg-[var(--ui-surface-3)] hover:text-white"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Link>
          <div>
            <div className="mb-2 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)]">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Creator identity
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white">Edit profile</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
              Keep the essentials clear. Add links and location only when they help people understand your work.
            </p>
          </div>
        </header>

        <DeferredCreatorProfileCard
          initialProfile={initialProfile}
          isLoading={false}
          loadError={loadError}
          collapseOptionalDetails
          hideIntro
          nextPath="/profile"
        />
      </div>
    </div>
  );
}
