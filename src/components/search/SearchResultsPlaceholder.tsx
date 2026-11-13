import type { PublicSearchType } from '@/lib/public-search';

/**
 * What the search page draws while its first answer for a search loads, where
 * there are no earlier cards to keep on show (dimmed) instead: blocks in the
 * shape of the tab's results, so the cards arrive where the eye already is and
 * nothing under them moves. The tab's own status line says "Searching…" to a
 * screen reader; this is drawing only, hidden from assistive technology. The
 * shimmer is motion: under reduced motion the blocks stand still.
 */

const BLOCK_CLASS = 'relative overflow-hidden rounded-3xl border border-white/8 bg-white/[0.035]';

function Shimmer() {
  return (
    <span
      className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/[0.05] to-transparent motion-safe:animate-[skeleton-shimmer_1.5s_linear_infinite] motion-reduce:hidden"
    />
  );
}

function Line({ className }: { className: string }) {
  return <span className={`block rounded-full bg-white/[0.07] ${className}`} />;
}

/**
 * A section's heading row, the height of the drawn one: an h2 of text-xl
 * beside Top's 44px "See all" (`h-11`), beside the 46px order control on Posts
 * and Recipes, or alone on Creators (`h-7`).
 */
function Heading({ height = 'h-11' }: { height?: string }) {
  return (
    <span className={`mb-4 flex items-center ${height}`}>
      <Line className="h-5 w-28" />
    </span>
  );
}

function PostCard() {
  return (
    <span className={`${BLOCK_CLASS} block`}>
      <span className="block aspect-[4/3] bg-white/[0.03]" />
      <span className="block p-4">
        <Line className="h-3.5 w-3/4" />
        <Line className="mt-2.5 h-3 w-1/3" />
        <Line className="mt-4 h-3 w-1/4" />
      </span>
      <Shimmer />
    </span>
  );
}

function CreatorRow() {
  return (
    <span className={`${BLOCK_CLASS} flex min-h-20 items-center gap-4 px-4 py-3`}>
      <span className="h-12 w-12 shrink-0 rounded-full bg-white/[0.07]" />
      <span className="min-w-0 flex-1">
        <Line className="h-3.5 w-1/3" />
        <Line className="mt-2.5 h-3 w-1/4" />
      </span>
      <Shimmer />
    </span>
  );
}

function RecipeCard() {
  return (
    <span className={`${BLOCK_CLASS} flex min-h-32`}>
      <span className="w-28 shrink-0 bg-white/[0.03] sm:w-36" />
      <span className="min-w-0 flex-1 p-4">
        <Line className="h-3.5 w-2/3" />
        <Line className="mt-2.5 h-3 w-full" />
        <Line className="mt-2 h-3 w-5/6" />
      </span>
      <Shimmer />
    </span>
  );
}

const POST_GRID_CLASS = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3';

function Posts({ count }: { count: number }) {
  return (
    <span className={POST_GRID_CLASS}>
      {Array.from({ length: count }, (_, index) => <PostCard key={index} />)}
    </span>
  );
}

export function SearchResultsPlaceholder({ type }: { type: PublicSearchType }) {
  return (
    <div aria-hidden="true" data-search-placeholder={type} className="space-y-10">
      {type === 'creators' ? (
        <span className="block">
          <Heading height="h-7" />
          <span className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 6 }, (_, index) => <CreatorRow key={index} />)}
          </span>
        </span>
      ) : type === 'recipes' ? (
        <span className="block">
          <Heading height="h-[46px]" />
          <span className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => <RecipeCard key={index} />)}
          </span>
        </span>
      ) : type === 'posts' ? (
        <span className="block">
          <Heading height="h-[46px]" />
          <Posts count={6} />
        </span>
      ) : (
        <>
          <span className="block">
            <Heading />
            <span className="grid gap-3 lg:grid-cols-2">
              <CreatorRow />
              <CreatorRow />
            </span>
          </span>
          <span className="block">
            <Heading />
            <Posts count={3} />
          </span>
        </>
      )}
    </div>
  );
}
