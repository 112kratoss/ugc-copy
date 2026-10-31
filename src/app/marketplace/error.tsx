'use client';

import { usePathname } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * A failed read under /marketplace (the seller dashboard loads every bundle,
 * order and deletion audit in one render) showed Next's bare error page, with
 * no way back to a seller's money page but the browser's reload.
 */
// `retry` refreshes the route and then resets; `reset` alone re-renders the
// same errored payload, so a database blip would stay on screen.
export default function MarketplaceError({ retry }: { retry: () => void }) {
  const pathname = usePathname();
  const isSellerDashboard = pathname === '/marketplace/sell' || pathname?.startsWith('/marketplace/sell/');

  return (
    <div className="ui-page ui-page-ambient px-4 py-8 sm:px-6 sm:py-12">
      <section
        role="alert"
        className="mx-auto max-w-2xl rounded-[28px] border border-rose-300/25 bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] sm:p-8"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-400/10 text-[var(--ui-accent-danger)]">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-[var(--ui-text-primary)]">
          {isSellerDashboard ? 'Could not load your recipe sales' : 'Could not load the marketplace'}
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--ui-text-secondary)]">
          {isSellerDashboard
            ? 'Your recipes, sales and payout balance are safe. Check the connection and try again.'
            : 'Recipes are temporarily unavailable. Check the connection and try again.'}
        </p>
        <button
          type="button"
          onClick={retry}
          className="ui-focus-ring mt-6 inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          {isSellerDashboard ? 'Retry dashboard' : 'Retry'}
        </button>
      </section>
    </div>
  );
}
