import { SkeletonBlock } from '@/components/TabLoadingShell';
import { SearchEntryLink } from '@/components/search/SearchEntryLink';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';

const PLACEHOLDER_CARDS = 8;

/**
 * The `(feed)` group exists so this stays the *tab's* loading state.
 *
 * A `loading.tsx` directly under `showcase/` wraps the whole subtree, so
 * opening a post showed a full-page "Loading Showcase" panel: the wrong page's
 * name, covering the shell it should have left alone, and pre-empting the
 * post's own boundary so that never got a turn. Keeping the feed in a route
 * group scopes the shell to `/showcase` and leaves `/showcase/[id]` alone,
 * where the top progress bar covers the wait instead.
 *
 * The wait draws Explore's own outline with no words (owner, 2026-11-14: the
 * shared tab card's "Community" and "Loading Explore" were not needed): the
 * header, the filter bar and the grid, at the page's padding and spacing, so
 * the page lands where its placeholders stood.
 */
export default function ShowcaseLoading() {
  return (
    <div className="ui-page ui-page-ambient min-h-screen py-5 sm:py-7">
      <section role="status" aria-live="polite" aria-label="Loading Explore" className="studio-shell relative z-10">
        {/* Explore opens on its search bar below 1024px: the loading state draws it
            too, so the bar does not arrive with the page and push it down. */}
        <SearchEntryLink className="mb-5 lg:hidden" />
        <div className="mb-7 border-b border-[var(--ui-border-subtle)] pb-7">
          <SkeletonBlock className="mb-3 h-4 w-40" />
          <SkeletonBlock className="h-10 w-48 sm:h-12" />
          <SkeletonBlock className="mt-3 h-4 w-full max-w-2xl" />
          <SkeletonBlock className="mt-2 h-4 w-2/3 max-w-md" />
        </div>
        <div className="mb-7 flex gap-2 rounded-4xl border border-[var(--ui-border-default)] bg-[rgba(25,25,28,0.92)] p-3 sm:p-4">
          <SkeletonBlock className="h-12 w-24" />
          <SkeletonBlock className="h-12 w-24" />
          <SkeletonBlock className="h-12 w-24" />
        </div>
        <div className={SHOWCASE_FEED_GRID_CLASS}>
          {Array.from({ length: PLACEHOLDER_CARDS }, (_, index) => (
            <SkeletonBlock key={index} className="aspect-[4/5]" />
          ))}
        </div>
      </section>
    </div>
  );
}
