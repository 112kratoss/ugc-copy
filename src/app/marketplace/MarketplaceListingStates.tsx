'use client';

import {
  MARKETPLACE_RECIPE_GRID_CLASS,
} from '@/app/marketplace/MarketplaceRecipeTile';
import { MARKETPLACE_INITIAL_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';

/** The tiles' own shape (`MarketplaceRecipeTile`), while a listing the page has not got is read. */
export function MarketplaceListingSkeleton() {
  return (
    <div aria-label="Loading marketplace recipes" aria-busy="true" className={MARKETPLACE_RECIPE_GRID_CLASS}>
      {Array.from({ length: MARKETPLACE_INITIAL_PAGE_SIZE }, (_, item) => (
        <div key={item} className="min-w-0">
          <div className="relative aspect-[4/5] overflow-hidden rounded-ui-2xl border border-white/8 bg-zinc-950/70">
            <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
          </div>
          <div className="mt-3 h-3.5 w-2/3 rounded-full bg-white/8" />
          <div className="mt-2.5 h-8 w-1/2 rounded-full bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

/** A listing the list API could not answer: say so, and ask again. */
export function MarketplaceListingFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mt-10 rounded-3xl border border-white/8 bg-zinc-950/70 p-8 text-center shadow-[0_24px_70px_rgba(0,0,0,0.35)]">
      <h2 className="text-2xl font-semibold text-white">Recipes could not load</h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-400">Check your connection, then try again.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
      >
        Try again
      </button>
    </div>
  );
}
