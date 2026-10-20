'use client';

import { RefreshCw } from 'lucide-react';

interface AlertsErrorCardProps {
  /** What went wrong and what the reader can do, under the heading. */
  detail: string;
  onRetry: () => void;
}

/**
 * "Could not load alerts", with a Retry. The signed-in half draws it when the
 * list read fails; the page draws it when the half itself does not load. It
 * lives in its own file, which globals.css scans, because in the second case
 * the half's sheet never arrived either: the card has to draw on globals.css
 * alone.
 */
export function AlertsErrorCard({ detail, onRetry }: AlertsErrorCardProps) {
  return (
    <div role="alert" className="rounded-3xl border border-rose-300/25 bg-rose-400/10 p-6">
      <h2 className="text-lg font-bold text-rose-200">Could not load alerts</h2>
      <p className="mt-2 text-sm text-[var(--ui-text-secondary)]">{detail}</p>
      <button onClick={onRetry} className="ui-focus-ring mt-5 inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)]">
        <RefreshCw className="h-4 w-4" aria-hidden />
        Retry
      </button>
    </div>
  );
}
