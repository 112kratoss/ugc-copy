import { Filter } from 'lucide-react';

/**
 * The panel the button opens, the shell's and the interactive list's alike (never both on the page).
 * Kept here, not in `MarketplaceBrowser.tsx`, which the shell loads only on demand.
 */
export const MARKETPLACE_FILTERS_ID = 'marketplace-filters';

const ALL_RECIPES_LINE = 'All quality-checked public recipes from community posts.';

/**
 * Opens or folds the filters (Access, Kind, Tool and the order) that a phone or a tablet keeps out
 * of the first screen, as Explore keeps its own (live sweep, 2026-11-17: at 375 × 812 the open
 * panel and the hero filled the screen, and the first recipe started a screen below). From 1024px
 * they stand open and the button is not drawn. The first-paint shell and the interactive list draw
 * this same button over the same panel, so the hand-over between them moves nothing.
 *
 * Open, or with a choice set behind it, it takes the coral wash Explore's Filters takes, and says
 * how many are set (review of #837: `?sort=price-low` on a phone showed nothing of the order).
 */
export default function MarketplaceFiltersButton({
  open,
  onToggle,
  controls,
  setCount = 0,
}: {
  open: boolean;
  onToggle: () => void;
  /** The id of the panel it opens. */
  controls: string;
  /** How many of the choices behind it are set: Access, Kind, Tool, an order other than Recent. */
  setCount?: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      // Named in full where something is set, its visible word first (the count alone says nothing read aloud).
      aria-label={setCount > 0 ? `Filters, ${setCount} set` : undefined}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium transition lg:hidden ${
        open || setCount > 0
          ? 'border-[rgba(255,122,89,0.32)] bg-[var(--ui-primary-soft)] text-[var(--ui-primary-strong)]'
          : 'border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]'
      }`}
    >
      <Filter className="h-4 w-4" />
      Filters
      {setCount > 0 ? (
        <span className="rounded-full bg-white/15 px-1.5 py-0.5 text-[11px] leading-none">{setCount}</span>
      ) : null}
    </button>
  );
}

/**
 * The line under "Buyer filters", the shell's and the interactive list's alike: what the listing is
 * narrowed to. Below 1024px, where the order is folded behind Filters with the rest, it also names
 * an order other than Recent (review of #837); from 1024px the order's own chips say it, and the
 * line is as it was. A phone with nothing set keeps the line out of its first screen.
 */
export function MarketplaceFiltersSummary({
  filterLabels,
  sortLabel,
}: {
  /** Access, Kind, Tool and the search, as set. */
  filterLabels: readonly string[];
  /** The order, when it is not Recent. */
  sortLabel: string | null;
}) {
  const sorted = sortLabel ? `Sorted by ${sortLabel}` : null;
  if (filterLabels.length > 0) {
    return (
      <p className="mt-1 text-sm text-zinc-400">
        {`Showing ${filterLabels.join(' + ')}`}
        {sorted ? <span className="lg:hidden">{` · ${sorted}`}</span> : null}
      </p>
    );
  }
  if (sorted) {
    return (
      <p className="mt-1 text-sm text-zinc-400">
        <span className="hidden lg:inline">{ALL_RECIPES_LINE}</span>
        <span className="lg:hidden">{sorted}</span>
      </p>
    );
  }
  return <p className="mt-1 hidden text-sm text-zinc-400 sm:block">{ALL_RECIPES_LINE}</p>;
}
