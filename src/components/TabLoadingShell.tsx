type TabLoadingShellAccent = 'blue' | 'emerald' | 'rose' | 'coral';

interface TabLoadingShellProps {
  /** Read to screen readers as "Loading <title>"; nothing on screen says it. */
  title: string;
  accent?: TabLoadingShellAccent;
}

const accentClasses: Record<TabLoadingShellAccent, string> = {
  blue: 'from-blue-500/22 via-sky-500/10 to-transparent text-blue-100 border-blue-300/20',
  emerald: 'from-emerald-500/22 via-teal-500/10 to-transparent text-emerald-100 border-emerald-300/20',
  rose: 'from-rose-500/20 via-orange-400/[0.07] to-transparent text-rose-100 border-rose-300/20',
  coral: 'from-[#2a1b1a] via-[#202024] to-[#19191c] text-[#fff8ed] border-white/10',
};

export function SkeletonBlock({ className = '' }: { className?: string }) {
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

/**
 * A tab's wait, drawn without words (owner, 2026-11-14): the label chip and
 * "Loading <tab>" title it used to carry flashed past on every tab switch and
 * said nothing the sidebar's highlighted tab did not. Placeholder bars stand
 * where they were. The tab's name stays for screen readers in a hidden line:
 * a live region is announced by the text inside it, not by its label.
 */
export default function TabLoadingShell({
  title,
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
        <span className="sr-only">Loading {title}</span>
        <div
          className={`rounded-3xl border bg-gradient-to-br ${accentClasses[accent]} p-5 shadow-[0_24px_80px_rgba(0,0,0,0.42)] sm:p-6`}
        >
          <SkeletonBlock className="h-6 w-28" />
          <div className="mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
            <div>
              <SkeletonBlock className="h-9 w-64 max-w-full sm:h-10" />
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
