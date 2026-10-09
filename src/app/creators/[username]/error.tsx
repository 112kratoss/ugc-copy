'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * A database blip on a shared creator link used to show Next's bare
 * "Application error" page; the app shows its own message with a retry.
 */
// `retry` refreshes the route and then resets; `reset` alone re-rendered the
// same errored payload, so a database blip stayed on screen.
export default function CreatorError({ retry }: { retry: () => void }) {
  return (
    <div className="ui-page ui-page-ambient min-h-[calc(100dvh-64px)] px-4 py-8 sm:px-6 sm:py-12">
      <section
        role="alert"
        className="mx-auto max-w-2xl rounded-[28px] border border-rose-300/25 bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-400/10 text-[var(--ui-accent-danger)]">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
          Could not load this creator
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--ui-text-secondary)]">
          The creator page is temporarily unavailable. Check the connection and try again.
        </p>
        <button
          type="button"
          onClick={retry}
          className="ui-focus-ring mt-6 inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </button>
      </section>
    </div>
  );
}
