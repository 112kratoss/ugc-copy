'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ChevronDown, CircleAlert, Copy, PencilLine, Plus } from 'lucide-react';

import { Button, IconButton, StatusCallout, Surface, Text, getAccentClasses, type UiAccent } from '@/components/DesignSystem';
import { buildShowcaseDetailPath, buildShowcaseDetailUrl } from '@/lib/share';

import SellerRecipeCover from './SellerRecipeCover';
import {
  SELLER_RECIPE_SORTS,
  SELLER_RETURN_PATH,
  buildAddRecipeHref,
  buildEditRecipeHref,
  describePaidRecipesNotOnSale,
  filterSellerRecipes,
  formatCount,
  formatSellerRecipeDetails,
  formatSellerRecipePrice,
  getPaidRecipesNotOnSale,
  getSellerRecipeState,
  getSellerRecipeTitle,
  getSellerRecipeUnlockCount,
  isSellerRecipeOnSale,
  sortSellerRecipes,
  type SellerRecipe,
  type SellerRecipeFilter,
  type SellerRecipeSort,
  type SellerRecipeTone,
} from './seller-recipes';

/** How many rows the list opens with; "Show all" draws the rest. */
const FIRST_ROWS = 8;

// A state's words take its tone's accent: a warning is the commerce accent's,
// as StatusCallout's is.
const TONE_ACCENT: Record<SellerRecipeTone, UiAccent> = {
  neutral: 'neutral',
  warning: 'commerce',
  danger: 'danger',
};

// The cover, the recipe, its price, the three counts and the row's actions:
// from 1024px, where the list has the page's width (the column beside it moves
// under it below 1400px). Narrower, a row is its cover, its title over a
// summary line, and its actions.
const ROW_COLUMNS = 'grid-cols-[3rem_minmax(0,1fr)_auto] lg:grid-cols-[3rem_minmax(0,1fr)_6rem_4rem_3.5rem_4rem_6.5rem]';

const FILTER_LABELS: Record<SellerRecipeFilter, string> = {
  all: 'All',
  live: 'Live',
  'not-live': 'Not live',
};

// A chip of the filter row and the sort menu, in the pill's size and colours.
// `.ui-pill` itself sits outside the utility layer, so a selected chip could
// not take its own border and wash over it.
const CHIP = 'ui-focus-ring inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors duration-150';
const CHIP_IDLE = 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-3)]';

// A copied link names where it was shared from (`?s=`): the post page counts
// a visit only from a link that does, and that count is the page's Link visits.
// Studio's surface: the owner sharing their own post, as there, and the share
// tables take only a fixed list of surfaces.
const COPIED_LINK_SURFACE = 'my-creations';

export default function SellerRecipeList({ recipes }: { recipes: SellerRecipe[] }) {
  const titleId = useId();
  const [filter, setFilter] = useState<SellerRecipeFilter>('all');
  const [sort, setSort] = useState<SellerRecipeSort>('unlocks');
  const [showAll, setShowAll] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const notLiveChip = useRef<HTMLButtonElement | null>(null);
  const copyTimer = useRef<number | null>(null);

  const liveCount = filterSellerRecipes(recipes, 'live').length;
  const counts: Record<SellerRecipeFilter, number> = {
    all: recipes.length,
    live: liveCount,
    'not-live': recipes.length - liveCount,
  };
  const listed = sortSellerRecipes(filterSellerRecipes(recipes, filter), sort);
  const shown = showAll ? listed : listed.slice(0, FIRST_ROWS);
  const notOnSale = describePaidRecipesNotOnSale(getPaidRecipesNotOnSale(recipes));
  const selectedChip = getAccentClasses('neutral').selected;

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const showFilter = (value: SellerRecipeFilter) => {
    setFilter(value);
    setShowAll(false);
  };

  const copyRecipeLink = async (postId: string) => {
    try {
      await navigator.clipboard.writeText(`${buildShowcaseDetailUrl(postId, window.location.origin, COPIED_LINK_SURFACE)}#recipe`);
      setCopyFeedback('Recipe link copied.');
    } catch {
      setCopyFeedback('Could not copy the recipe link.');
    }
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyFeedback(null), 2200);
  };

  return (
    <Surface as="section" variant="card" padding="none" className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 pb-4 pt-5 sm:px-6">
        <Text as="h2" variant="cardTitle" id={titleId}>Your recipes</Text>
        <div role="group" aria-label="Show recipes" className="order-last flex w-full flex-wrap gap-2 sm:order-none sm:ml-auto sm:w-auto">
          {(Object.keys(FILTER_LABELS) as SellerRecipeFilter[]).map((value) => (
            <button
              key={value}
              ref={value === 'not-live' ? notLiveChip : undefined}
              type="button"
              aria-pressed={filter === value}
              onClick={() => showFilter(value)}
              className={clsx(CHIP, filter === value ? selectedChip : CHIP_IDLE)}
            >
              {FILTER_LABELS[value]}
              {/* The space keeps the chip's name "Live 1"; flex layout drops it from view. */}
              {' '}
              <span className="tabular-nums text-[var(--ui-text-faint)]">{counts[value]}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto sm:ml-0">
          <span className="sr-only">Sort recipes</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SellerRecipeSort)}
            className={clsx(CHIP, CHIP_IDLE, 'cursor-pointer appearance-none pr-8')}
          >
            {SELLER_RECIPE_SORTS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ui-text-muted)]" aria-hidden="true" />
        </label>
      </div>

      {notOnSale ? (
        <StatusCallout
          tone="warning"
          icon={CircleAlert}
          title={notOnSale.title}
          body={notOnSale.body}
          className="mx-4 mb-4 sm:mx-6"
          // The whole "Not live" list, which can hold more than the paid
          // recipes the callout counts: free drafts, and removed ones.
          action={filter !== 'not-live' ? (
            <Button
              variant="ghost"
              onClick={() => {
                showFilter('not-live');
                // The button goes with the filter it set: the focus goes to
                // that filter's chip, which now says what the list shows.
                notLiveChip.current?.focus();
              }}
            >
              Show what isn’t live
            </Button>
          ) : undefined}
        />
      ) : null}

      {/* Mounted while empty, so a screen reader announces what lands in it. */}
      <p role="status" className={clsx('mx-4 text-sm font-medium text-[var(--ui-accent-workflow)] sm:mx-6', copyFeedback ? 'mb-4' : 'sr-only')}>
        {copyFeedback}
      </p>

      <div aria-hidden="true" className={clsx('hidden gap-3 border-t border-[var(--ui-border-subtle)] px-6 py-2 lg:grid', ROW_COLUMNS)}>
        <span />
        <Text as="span" variant="caption">Recipe</Text>
        <Text as="span" variant="caption">Price</Text>
        <Text as="span" variant="caption" className="text-right">Unlocks</Text>
        <Text as="span" variant="caption" className="text-right">Saves</Text>
        <Text as="span" variant="caption" className="text-right">Link visits</Text>
        <span />
      </div>

      {shown.length > 0 ? (
        <ul ref={listRef} aria-labelledby={titleId}>
          {shown.map((recipe) => (
            <SellerRecipeRow key={recipe.id} recipe={recipe} onCopyLink={copyRecipeLink} />
          ))}
        </ul>
      ) : (
        <Text variant="bodySm" className="border-t border-[var(--ui-border-subtle)] px-4 py-6 sm:px-6">
          {filter === 'live' ? 'None of your recipes is live yet.' : 'All your recipes are live.'}
        </Text>
      )}

      {listed.length > shown.length ? (
        <button
          type="button"
          onClick={() => {
            const firstNewRow = shown.length;
            // The button goes with the rows it draws: drawn now, the focus
            // goes to the first of them, not to the page's body.
            flushSync(() => setShowAll(true));
            listRef.current?.querySelectorAll<HTMLElement>(':scope > li')[firstNewRow]?.querySelector<HTMLElement>('a, p[tabindex]')?.focus();
          }}
          // The ring is drawn inside: the card clips anything past its edge.
          className="flex min-h-12 w-full items-center justify-center gap-2 border-t border-[var(--ui-border-subtle)] text-sm font-semibold text-[var(--ui-text-secondary)] outline-none transition-colors duration-150 hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ui-focus)]"
        >
          Show all {listed.length}
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </Surface>
  );
}

function SellerRecipeRow({
  recipe,
  onCopyLink,
}: {
  recipe: SellerRecipe;
  onCopyLink: (postId: string) => void;
}) {
  const state = getSellerRecipeState(recipe);
  const title = getSellerRecipeTitle(recipe);
  const details = formatSellerRecipeDetails(recipe);
  const unlocks = getSellerRecipeUnlockCount(recipe);
  const saves = recipe.post?.saveCount ?? 0;
  const visits = recipe.post?.shareVisitCount ?? 0;
  const onSale = isSellerRecipeOnSale(state);
  const ended = state.kind === 'ended';
  const removed = state.kind === 'removed';
  // The editor takes a recipe again on a post whose recipe was removed.
  const editHref = removed ? buildAddRecipeHref(recipe.postId) : buildEditRecipeHref(recipe.postId);
  // A recipe on sale opens where buyers unlock it; one that is not opens the
  // editor at the recipe, where what keeps it off sale is fixed, or a recipe
  // is added again. One whose post was deleted opens nothing.
  const href = ended
    ? null
    : onSale
      ? buildShowcaseDetailPath(recipe.postId, { from: 'seller', returnTo: SELLER_RETURN_PATH, section: 'resources' })
      : editHref;
  const priceChip = (
    <span
      className={clsx(
        'inline-flex min-h-7 items-center whitespace-nowrap rounded-full border px-2.5 text-xs font-bold',
        recipe.accessMode === 'paid'
          ? getAccentClasses('commerce').badge
          : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-3)] text-[var(--ui-text-secondary)]',
      )}
    >
      {formatSellerRecipePrice(recipe)}
    </span>
  );
  // The header row is for the eye; each count names itself to a screen reader.
  const count = (value: number, label: string) => (
    <span className={clsx('hidden text-right text-sm font-semibold tabular-nums lg:block', value === 0 ? 'text-[var(--ui-text-faint)]' : 'text-[var(--ui-text-secondary)]')}>
      {value.toLocaleString('en-US')}
      <span className="sr-only"> {label}</span>
    </span>
  );

  return (
    <li
      className={clsx(
        'relative grid items-center gap-3 border-t border-[var(--ui-border-subtle)] px-4 py-3 transition-colors duration-150 sm:px-6',
        ROW_COLUMNS,
        href && 'hover:bg-[var(--ui-surface-2)]',
      )}
    >
      <SellerRecipeCover post={recipe.post} />
      <div className="min-w-0">
        {/* The title's link covers the whole row (its ::after); the row's own
            buttons sit above it. */}
        {href ? (
          <Link
            href={href}
            prefetch={false}
            className="ui-focus-ring block truncate rounded-sm text-sm font-semibold leading-6 text-[var(--ui-text-primary)] after:absolute after:inset-0 sm:text-base"
          >
            {title}
          </Link>
        ) : (
          <p tabIndex={-1} className="truncate text-sm font-semibold leading-6 text-[var(--ui-text-primary)] outline-none sm:text-base">{title}</p>
        )}
        <p className="mt-0.5 truncate text-xs font-medium leading-5 text-[var(--ui-text-faint)]">
          {state.kind !== 'live' ? (
            <span className={clsx('font-bold', getAccentClasses(TONE_ACCENT[state.tone]).mark)}>
              {state.label}
              {details ? ' · ' : ''}
            </span>
          ) : null}
          {details}
        </p>
        <div className="mt-1.5 flex items-center gap-2 text-xs font-semibold text-[var(--ui-text-muted)] lg:hidden">
          {priceChip}
          <span className="truncate">
            {[
              formatCount(unlocks, 'unlock', 'unlocks'),
              saves > 0 ? formatCount(saves, 'save', 'saves') : null,
              visits > 0 ? formatCount(visits, 'link visit', 'link visits') : null,
            ].filter(Boolean).join(' · ')}
          </span>
        </div>
        {(state.kind === 'not-live' || state.kind === 'unlisted') && state.issue ? (
          <p className="mt-1 text-xs leading-5 text-[var(--ui-accent-danger)]">{state.issue}</p>
        ) : null}
      </div>
      <span className="hidden lg:block">{priceChip}</span>
      {count(unlocks, unlocks === 1 ? 'unlock' : 'unlocks')}
      {count(saves, saves === 1 ? 'save' : 'saves')}
      {count(visits, visits === 1 ? 'link visit' : 'link visits')}
      <div className="relative z-10 flex items-center justify-end gap-2">
        {onSale ? (
          // Copying is a laptop's errand; a phone shares from the post.
          <span className="hidden sm:inline-flex">
            <IconButton label="Copy recipe link" icon={Copy} onClick={() => onCopyLink(recipe.postId)} />
          </span>
        ) : null}
        {!ended ? (
          <IconButton
            label={removed ? 'Add a recipe again' : 'Edit recipe'}
            href={editHref}
            prefetch={false}
            icon={removed ? Plus : PencilLine}
          />
        ) : null}
      </div>
    </li>
  );
}
