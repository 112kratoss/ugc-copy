import { Filter } from 'lucide-react';

/**
 * The panel the button opens, the shell's and the interactive list's alike (never both on the page).
 * Kept here, not in `MarketplaceBrowser.tsx`, which the shell loads only on demand.
 */
export const MARKETPLACE_FILTERS_ID = 'marketplace-filters';

/**
 * Opens or folds the filters (Access, Kind, Tool and the order) that a phone or a tablet keeps out
 * of the first screen, as Explore keeps its own (live sweep, 2026-11-17: at 375 × 812 the open
 * panel and the hero filled the screen, and the first recipe started a screen below). From 1024px
 * they stand open and the button is not drawn. The first-paint shell and the interactive list draw
 * this same button over the same panel, so the hand-over between them moves nothing.
 */
export default function MarketplaceFiltersButton({
  open,
  onToggle,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  /** The id of the panel it opens. */
  controls: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      // Open, it takes the coral wash Explore's Filters takes: the selected state is drawn.
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium transition lg:hidden ${
        open
          ? 'border-[rgba(255,122,89,0.32)] bg-[var(--ui-primary-soft)] text-[var(--ui-primary-strong)]'
          : 'border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]'
      }`}
    >
      <Filter className="h-4 w-4" />
      Filters
    </button>
  );
}
