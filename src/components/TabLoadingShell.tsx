type TabLoadingShellAccent = 'blue' | 'emerald' | 'rose' | 'coral';

interface TabLoadingShellProps {
  title: string;
  eyebrow: string;
  accent?: TabLoadingShellAccent;
}

const accentClasses: Record<TabLoadingShellAccent, string> = {
  blue: 'from-blue-500/22 via-sky-500/10 to-transparent text-blue-100 border-blue-300/20',
  emerald: 'from-emerald-500/22 via-teal-500/10 to-transparent text-emerald-100 border-emerald-300/20',
  rose: 'from-rose-500/20 via-orange-400/[0.07] to-transparent text-rose-100 border-rose-300/20',
  coral: 'from-[#2a1b1a] via-[#202024] to-[#19191c] text-[#fff8ed] border-white/10',
};

function SkeletonBlock({ className = '' }: { className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/8 bg-white/[0.035] ${className}`}
    >
      <div
        className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/6 to-transparent"
        aria-hidden="true"
      />
    </div>
  );
}

export default function TabLoadingShell({
  title,
  eyebrow,
  accent = 'blue',
}: TabLoadingShellProps) {
  return (
    <div className="min-h-screen bg-black text-white">
      <section
        role="status"
        aria-live="polite"
        aria-label={`Loading ${title}`}
        className="studio-shell py-8 sm:py-10"
      >
        <div
          className={`rounded-[30px] border bg-gradient-to-br ${accentClasses[accent]} p-5 shadow-[0_24px_80px_rgba(0,0,0,0.42)] sm:p-6`}
        >
          <div className="inline-flex rounded-full border border-white/10 bg-black/25 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
            {eyebrow}
          </div>
          <div className="mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Loading {title}
              </h2>
              <div className="mt-5 space-y-3">
                <SkeletonBlock className="h-4 max-w-lg" />
                <SkeletonBlock className="h-4 max-w-sm" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <SkeletonBlock className="aspect-[4/3]" />
              <SkeletonBlock className="aspect-[4/3]" />
              <SkeletonBlock className="aspect-[4/3]" />
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-48" />
        </div>
      </section>
    </div>
  );
}
