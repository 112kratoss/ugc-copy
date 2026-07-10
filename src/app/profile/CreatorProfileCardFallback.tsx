import type { EditableCreatorProfile } from '@/lib/profile';

interface CreatorProfileCardFallbackProps {
  initialProfile: EditableCreatorProfile | null;
  isLoading: boolean;
  loadError: string | null;
  onboardingMode?: boolean;
}

export default function CreatorProfileCardFallback({
  initialProfile,
  isLoading,
  loadError,
  onboardingMode = false,
}: CreatorProfileCardFallbackProps) {
  const displayName = initialProfile?.displayName?.trim() || initialProfile?.username?.trim() || 'Creator profile';
  const username = initialProfile?.username?.trim();
  const bio = initialProfile?.bio?.trim();

  if (loadError) {
    return (
      <section className="rounded-[28px] border border-red-500/20 bg-red-500/10 p-6 text-sm text-red-100">
        {loadError}
      </section>
    );
  }

  return (
    <section
      aria-busy={isLoading || undefined}
      className="overflow-hidden rounded-[28px] border border-white/8 bg-zinc-950/80 shadow-[0_24px_70px_rgba(0,0,0,0.35)]"
    >
      <div className="h-24 bg-gradient-to-r from-[#19191c] via-[#202024] to-[#2a1b1a]" />
      <div className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-end gap-4">
            <div className="h-20 w-20 shrink-0 rounded-2xl border border-white/12 bg-zinc-900 shadow-2xl" />
            <div className="min-w-0 pb-1">
              <p className="truncate text-xl font-semibold tracking-tight text-white">{displayName}</p>
              <p className="mt-1 text-sm text-zinc-400">{username ? `@${username}` : 'Handle pending'}</p>
            </div>
          </div>
          {onboardingMode ? (
            <div className="rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-sky-100">
              Setup
            </div>
          ) : null}
        </div>

        <p className="mt-5 min-h-10 max-w-2xl text-sm leading-6 text-zinc-400">
          {bio || ' '}
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {[64, 80, 56, 72].map((width, index) => (
            <div key={index} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div
                className="h-3 rounded-full bg-white/8"
                style={{ width }}
              />
              <div className="mt-3 h-9 overflow-hidden rounded-xl border border-white/6 bg-black/20">
                <div className="h-full w-1/2 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/8 to-transparent" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
