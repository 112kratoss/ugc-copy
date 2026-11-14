import { SkeletonBlock } from '@/components/TabLoadingShell';
import { SearchEntryLink } from '@/components/search/SearchEntryLink';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';

const PLACEHOLDER_CARDS = 8;

/**
 * One line of the page's text as a placeholder: a box of the line's height
 * (`lineClassName`) holding a bar, so the placeholder is as tall as the text
 * it stands for and the page does not move when it arrives.
 */
function LinePlaceholder({ lineClassName, barClassName }: { lineClassName: string; barClassName: string }) {
  return (
    <div className={`flex items-center ${lineClassName}`}>
      <SkeletonBlock className={barClassName} />
    </div>
  );
}

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
 * shared tab card's "Community" and "Loading Explore" were not needed). Each
 * box repeats the page's own (ShowcaseBootstrapClient, then ShowcaseClient):
 * the header with its eyebrow, title and two-to-three-line blurb at their
 * line heights and the "Browse recipes" pill (under the text below 1024px),
 * the filter bar's two rows below 1024px and one above, and cards of a 4:5
 * picture over a title and byline, so the page lands where its placeholders
 * stood at every width. The status region keeps the tab's name for screen
 * readers in a hidden line, which is what a live region reads out.
 */
export default function ShowcaseLoading() {
  return (
    <div className="ui-page ui-page-ambient min-h-screen py-5 sm:py-7">
      <section role="status" aria-live="polite" aria-label="Loading Explore" className="studio-shell relative z-10">
        <span className="sr-only">Loading Explore</span>
        {/* Explore opens on its search bar below 1024px: the loading state draws it
            too, so the bar does not arrive with the page and push it down. */}
        <SearchEntryLink className="mb-5 lg:hidden" />

        <div className="mb-7 flex flex-col gap-5 border-b border-[var(--ui-border-subtle)] pb-7 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1">
            {/* Eyebrow: an inline-flex text-xs row, which the page's 16px/1.5 text sets in
                a 21px line box (measured, 2026-11-14). */}
            <LinePlaceholder lineClassName="mb-3 h-[21px]" barClassName="h-3 w-40" />
            {/* Title: text-4xl (40px line), sm:text-5xl (48px line). */}
            <LinePlaceholder lineClassName="h-10 sm:h-12" barClassName="h-8 w-44 sm:h-10 sm:w-52" />
            {/* Blurb: 24px lines, three on a phone and two from 640px. */}
            <div className="mt-3 max-w-2xl">
              <LinePlaceholder lineClassName="h-6" barClassName="h-3.5 w-full" />
              <LinePlaceholder lineClassName="h-6" barClassName="h-3.5 w-full sm:w-3/4" />
              <LinePlaceholder lineClassName="h-6 sm:hidden" barClassName="h-3.5 w-1/2" />
            </div>
          </div>
          {/* "Browse recipes". */}
          <SkeletonBlock className="h-12 w-40 shrink-0" />
        </div>

        <div className="mb-7 rounded-4xl border border-[var(--ui-border-default)] bg-[rgba(25,25,28,0.92)] p-3 sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {/* Media type: All posts, Images, Videos. */}
            <div className="flex gap-2 pb-1 sm:pb-0">
              <SkeletonBlock className="h-12 w-24" />
              <SkeletonBlock className="h-12 w-24" />
              <SkeletonBlock className="h-12 w-24" />
            </div>
            {/* Sort (and Filters once the full page runs). */}
            <div className="flex gap-2">
              <SkeletonBlock className="h-12 w-28" />
              <SkeletonBlock className="h-12 w-24" />
            </div>
          </div>
        </div>

        <div className={SHOWCASE_FEED_GRID_CLASS}>
          {Array.from({ length: PLACEHOLDER_CARDS }, (_, index) => (
            <div key={index} className="min-w-0 overflow-hidden rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]">
              <SkeletonBlock className="aspect-[4/5]" />
              {/* Title (text-sm, 20px) over the byline (24px), in px-4 py-3. */}
              <div className="px-4 py-3">
                <LinePlaceholder lineClassName="h-5" barClassName="h-3.5 w-3/4" />
                <LinePlaceholder lineClassName="mt-1 h-6" barClassName="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
