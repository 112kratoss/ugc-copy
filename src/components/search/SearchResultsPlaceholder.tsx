import type { PublicSearchType } from '@/lib/public-search';

/**
 * What the search page draws while its first answer for a search loads, where
 * there are no earlier cards to keep on show (dimmed) instead: blocks in the
 * shape of the tab's results, so the cards arrive where the eye already is and
 * nothing under them moves. The tab's own status line says "Searching…" to a
 * screen reader; this is drawing only, hidden from assistive technology. The
 * shimmer is motion: under reduced motion the blocks stand still.
 */

const BLOCK_CLASS = 'relative overflow-hidden border border-white/8 bg-white/[0.035]';

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
 * beside Top's 44px "See all" (`h-11`), beside the 48px order control on Posts
 * and Recipes (`h-12`), or alone on Creators (`h-7`).
 */
function Heading({ height = 'h-11' }: { height?: string }) {
  return (
    <span className={`mb-4 flex items-center ${height}`}>
      <Line className="h-5 w-28" />
    </span>
  );
}

// The wall's cards keep their pictures' shapes: the blocks stand in a few of them.
const POST_SHAPES = ['4 / 5', '1 / 1', '3 / 4', '4 / 5', '16 / 9', '3 / 4', '1 / 1', '4 / 5'];

function PostCard({ shape }: { shape: string }) {
  return (
    <span className="block">
      <span className={`${BLOCK_CLASS} block rounded-3xl`} style={{ aspectRatio: shape }}>
        <Shimmer />
      </span>
      <span className="mt-2.5 block px-1.5">
        <Line className="h-3.5 w-3/4" />
        <Line className="mt-2.5 h-3 w-1/2" />
      </span>
    </span>
  );
}

function CreatorRow() {
  return (
    <span className={`${BLOCK_CLASS} flex min-h-20 items-center gap-4 rounded-2xl p-3`}>
      <span className="h-13 w-13 shrink-0 rounded-full bg-white/[0.07]" />
      <span className="min-w-0 flex-1">
        <Line className="h-3.5 w-1/3" />
        <Line className="mt-2.5 h-3 w-1/4" />
        <Line className="mt-2.5 h-3 w-1/2" />
      </span>
      <Shimmer />
    </span>
  );
}

function RecipeCard() {
  return (
    <span className={`${BLOCK_CLASS} flex min-h-32 rounded-2xl`}>
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

/** The posts wall's columns before it is measured (SearchPostWall): two, three, four as it widens. */
function Posts({ count }: { count: number }) {
  return (
    <span className="block @container">
      <span className="grid grid-cols-2 items-start gap-3 @min-[600px]:grid-cols-3 @min-[600px]:gap-4 @min-[900px]:grid-cols-4">
        {Array.from({ length: count }, (_, index) => <PostCard key={index} shape={POST_SHAPES[index % POST_SHAPES.length]} />)}
      </span>
    </span>
  );
}

/**
 * `creatorsOnly`: the query is too short for posts and recipes (under three
 * characters only creators are searched), so Top draws the creators' block
 * alone: blocks for posts that can never come flashed and collapsed at every
 * search that passed through two characters. Models and tools are not drawn
 * ahead: whether an answer leads with them cannot be known before it lands.
 */
export function SearchResultsPlaceholder({ type, creatorsOnly = false }: { type: PublicSearchType; creatorsOnly?: boolean }) {
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
          <Heading height="h-12" />
          <span className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => <RecipeCard key={index} />)}
          </span>
        </span>
      ) : type === 'posts' ? (
        <span className="block">
          <Heading height="h-12" />
          <Posts count={8} />
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
          {creatorsOnly ? null : (
            <span className="block">
              <Heading />
              <Posts count={4} />
            </span>
          )}
        </>
      )}
    </div>
  );
}
