'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';

/**
 * A failure on a route with no error file of its own (Home, Pricing, the creators, the profile…)
 * showed Next's bare "Application error" page, with no navigation and no retry. This one draws
 * inside the app shell, as not-found.tsx does, on globals.css alone. Plain markup, not the design
 * system's components: an error file rides in every page's first load
 * (`post-page-first-load-imports.test.ts`).
 *
 * `retry` re-fetches the segment and then resets; `reset` alone re-renders the same errored
 * payload, so a database blip would stay on screen.
 */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="ui-page ui-page-ambient px-4 py-8 sm:px-6 sm:py-12">
      <section
        role="alert"
        className="mx-auto max-w-2xl rounded-3xl border border-rose-300/25 bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-400/10 text-[var(--ui-accent-danger)]">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
          Something went wrong
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--ui-text-secondary)]">
          This page could not be loaded. Your account and creations are safe. Check the connection and try again.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={retry}
            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry
          </button>
          <Link href="/" prefetch={false} className="ui-button ui-button-secondary ui-focus-ring">
            <Home className="h-4 w-4" aria-hidden />
            Go to Home
          </Link>
        </div>
      </section>
    </div>
  );
}
