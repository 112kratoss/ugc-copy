'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, Heart, History, Link2, LockOpen, Plus, ShoppingBag, X, type LucideIcon } from 'lucide-react';

import { Button, Surface, Text, getAccentClasses } from '@/components/DesignSystem';
import {
  formatUnlockCountLabel,
  formatUsdCents,
  getPostResourceKindLabel,
} from '@/lib/post-resource-bundles';
import { POST_RESOURCE_CREATOR_SHARE_PERCENT } from '@/lib/post-resource-commerce';

import PayoutPanel from './PayoutPanel';
import RecipeCandidatePicker, { type SellerRecipeCandidateView } from './RecipeCandidatePicker';
import SellerRecipeList from './SellerRecipeList';
import { ReadyForRecipe, RecentUnlocks, type SellerRecipeUnlockView } from './SellerRecipeRail';
import {
  formatCount,
  formatSellerRecipePrice,
  getSellerRecipeTitle,
  type SellerRecipe,
  type SellerRecipeKind,
} from './seller-recipes';

interface DeletedSnapshot {
  id: string;
  title: string;
  visibility: string;
  bundleAccessMode: 'free' | 'paid' | null;
  bundleStatus: 'draft' | 'published' | null;
  bundlePriceUsdCents: number | null;
  resourceKinds: SellerRecipeKind[];
  salesCount: number;
  earningsUsdCents: number;
  hadPaidOrders: boolean;
  deletedAt: string;
}

interface SellerDashboardPayload {
  bundles: SellerRecipe[];
  deletedSnapshots: DeletedSnapshot[];
  recentUnlocks: SellerRecipeUnlockView[];
  /** Null when the seller's posts could not be read. */
  recipeCandidates: SellerRecipeCandidateView[] | null;
  totalSalesCount: number;
  totalFreeUnlockCount: number;
  totalEarningsUsdCents: number;
  generatedAt?: string;
}

interface MarketplaceSellClientProps {
  initialDashboard: SellerDashboardPayload;
}

const subscribeToHydration = () => () => undefined;
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

// The page is rendered on the server, in UTC and the server's locale, and
// hydrated in the seller's zone and locale; a date formatted for the browser
// there did not match the server's text. The server and the first client pass
// print the same fixed form, and the hydrated page redraws it locally.
const SERVER_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const SERVER_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

// A date of another year than the page's own read names its year: "Apr 20"
// read in February reads as this April. The years are UTC ones, so the server
// and the browser agree on which dates do.
function formatSellerDate(value: string, hydrated: boolean, readAt: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const withYear = !readAt || new Date(readAt).getUTCFullYear() !== date.getUTCFullYear();
  if (!hydrated) return (withYear ? SERVER_DATE_FORMATTER : SERVER_DAY_FORMATTER).format(date);
  return date.toLocaleDateString(undefined, withYear ? { dateStyle: 'medium' } : { month: 'short', day: 'numeric' });
}

export default function MarketplaceSellClient({
  initialDashboard,
}: MarketplaceSellClientProps) {
  const { bundles } = initialDashboard;
  const deletedSnapshots = initialDashboard.deletedSnapshots ?? [];
  const recentUnlocks = initialDashboard.recentUnlocks ?? [];
  const recipeCandidates = initialDashboard.recipeCandidates ?? null;
  const pickerId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot
  );
  const readAt = initialDashboard.generatedAt ? new Date(initialDashboard.generatedAt).getTime() : 0;
  const formatWhen = (value: string) => formatSellerDate(value, hydrated, readAt);

  const hasRecipes = bundles.length > 0;
  const hasSuggestions = (recipeCandidates?.length ?? 0) > 0;
  const recipeTitles = useMemo(
    () => new Map(bundles.map((bundle) => [bundle.id, getSellerRecipeTitle(bundle)])),
    [bundles],
  );
  const totals = bundles.reduce(
    (sum, bundle) => ({
      saves: sum.saves + (bundle.post?.saveCount ?? 0),
      remixes: sum.remixes + (bundle.post?.remixCount ?? 0),
      visits: sum.visits + (bundle.post?.shareVisitCount ?? 0),
    }),
    { saves: 0, remixes: 0, visits: 0 },
  );
  const latestUnlock = recentUnlocks[0]?.createdAt ?? null;

  return (
    <div className="ui-page">
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Link
              href="/marketplace"
              className="ui-focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full text-sm font-semibold text-[var(--ui-text-muted)] transition-colors duration-150 hover:text-[var(--ui-text-primary)]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Marketplace
            </Link>
            <Text as="h1" variant="pageTitle" className="mt-2">Recipe sales</Text>
            <Text variant="bodySm" className="mt-2 sm:text-base">What your recipes earn, and how people find them.</Text>
          </div>
          {hasRecipes ? (
            <Button
              variant="primary"
              icon={pickerOpen ? X : Plus}
              iconPosition="start"
              ariaExpanded={pickerOpen}
              ariaControls={pickerOpen ? pickerId : undefined}
              onClick={() => setPickerOpen((open) => !open)}
              className="sm:shrink-0"
            >
              Add a recipe
            </Button>
          ) : null}
        </header>

        {hasRecipes ? (
          // A disclosure, drawn under the button that opens it while it is open.
          pickerOpen ? (
            <Surface as="section" variant="card" padding="lg" className="mt-6">
              <div id={pickerId} role="group" aria-labelledby={`${pickerId}-title`}>
                <Text as="h2" variant="cardTitle" id={`${pickerId}-title`}>Add a recipe to a post</Text>
                <Text variant="bodySm" className="mb-5 mt-1">
                  Pick a post, then choose what people get and whether it’s free.
                </Text>
                <RecipeCandidatePicker
                  candidates={recipeCandidates}
                  emptyText="No public post of yours is waiting for a recipe."
                />
              </div>
            </Surface>
          ) : null
        ) : (
          <Surface as="section" variant="card" padding="lg" className="mt-8">
            <span className={clsx('inline-flex h-11 w-11 items-center justify-center rounded-ui-lg border', getAccentClasses('commerce').iconWrap)}>
              <ShoppingBag className="h-5 w-5" aria-hidden="true" />
            </span>
            <Text as="h2" variant="sectionTitle" className="mt-4">Add your first recipe</Text>
            <Text variant="body" className="mb-6 mt-2 max-w-2xl">
              A recipe is what’s behind a post: its prompt, settings, files or notes. Add one to a post, keep it
              free or set a price, and people unlock it from the post. You keep {POST_RESOURCE_CREATOR_SHARE_PERCENT}% of every sale.
            </Text>
            <RecipeCandidatePicker
              candidates={recipeCandidates}
              emptyText="Your public posts show up here once you share one."
            />
          </Surface>
        )}

        {hasRecipes ? (
          // Four tiles from 1280px; narrower, Earnings has a row of its own over the three counts.
          <section aria-label="Overview" className="mt-8 grid grid-cols-3 gap-3 sm:gap-4 xl:grid-cols-4">
            <PayoutPanel className="col-span-3 xl:col-span-1" />
            <StatTile
              icon={LockOpen}
              label="Unlocks"
              value={initialDashboard.totalSalesCount + initialDashboard.totalFreeUnlockCount}
              detail={`${initialDashboard.totalFreeUnlockCount.toLocaleString('en-US')} opened free · ${initialDashboard.totalSalesCount.toLocaleString('en-US')} sold`}
              foot={latestUnlock ? <>Latest <time dateTime={latestUnlock}>{formatWhen(latestUnlock)}</time></> : null}
            />
            {/* Both counted over the posts that carry a recipe, which the tiles say. */}
            <StatTile
              icon={Heart}
              label="Saves"
              value={totals.saves}
              detail={`and ${formatCount(totals.remixes, 'remix', 'remixes')}, on posts with a recipe`}
            />
            {/* `share_visit_count`: a visit through anyone's shared link (`?s=`), the seller's or not. */}
            <StatTile
              icon={Link2}
              label="Visits from shared links"
              shortLabel="Link visits"
              value={totals.visits}
              detail="Opened from a link to a post with a recipe"
            />
          </section>
        ) : (
          // A balance with no recipe left to list (a legacy listing, every
          // recipe gone) still has its payout here: /delete-account and the
          // app send sellers to this page for it. Nothing shows without one.
          <div className="mt-8 grid grid-cols-3 gap-3 sm:gap-4 xl:grid-cols-4">
            <PayoutPanel className="col-span-3 xl:col-span-1" hideWhenEmpty />
          </div>
        )}

        {hasRecipes ? (
          // The column beside the list from 1400px, where the list keeps room
          // for its columns beside the shell's sidebar; under it before that.
          // In rem, as the theme's breakpoints are: Tailwind puts a px
          // breakpoint before every rem one, so `md:` outranked it.
          <div className="mt-4 grid items-start gap-4 min-[87.5rem]:grid-cols-[minmax(0,1fr)_20rem]">
            <SellerRecipeList recipes={bundles} />
            {/* Columns that can shrink (`grid-cols-*`): an implicit column took
                the width of the longest truncated title, 812px on a phone. */}
            <aside
              aria-label="Unlocks and suggestions"
              className={clsx(
                'grid min-w-0 grid-cols-1 items-start gap-4',
                hasSuggestions && 'md:grid-cols-2 min-[87.5rem]:grid-cols-1',
              )}
            >
              <RecentUnlocks
                unlocks={recentUnlocks}
                recipeTitleFor={(bundleId) => recipeTitles.get(bundleId) ?? 'a recipe'}
                formatWhen={formatWhen}
              />
              <ReadyForRecipe candidates={recipeCandidates ?? []} />
            </aside>
          </div>
        ) : null}

        {deletedSnapshots.length > 0 ? (
          <Surface as="section" variant="card" padding="none" className="mt-4">
            <details className="group">
              <summary className="ui-focus-ring flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-ui-2xl px-4 text-sm font-semibold text-[var(--ui-text-secondary)] sm:px-6 [&::-webkit-details-marker]:hidden">
                <History className="h-4 w-4 text-[var(--ui-text-muted)]" aria-hidden="true" />
                Deleted posts that had recipes
                <span className="tabular-nums text-[var(--ui-text-faint)]">{deletedSnapshots.length}</span>
                <ChevronDown className="ml-auto h-4 w-4 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
              </summary>
              <ul className="divide-y divide-[var(--ui-border-subtle)] border-t border-[var(--ui-border-subtle)]">
                {deletedSnapshots.map((snapshot) => (
                  <li key={snapshot.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-6">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{snapshot.title}</p>
                      <p className="mt-0.5 text-xs text-[var(--ui-text-faint)]">
                        {[
                          snapshot.bundleAccessMode
                            ? formatSellerRecipePrice({ accessMode: snapshot.bundleAccessMode, priceUsdCents: snapshot.bundlePriceUsdCents ?? 0 })
                            : null,
                          (snapshot.resourceKinds ?? []).map(getPostResourceKindLabel).join(', ') || null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <p className="text-xs text-[var(--ui-text-muted)]">
                      {snapshot.bundleAccessMode
                        ? formatUnlockCountLabel(snapshot.bundleAccessMode, snapshot.salesCount)
                        : `${snapshot.salesCount} ${snapshot.salesCount === 1 ? 'sale' : 'sales'}`}
                      {' · '}
                      {formatUsdCents(snapshot.earningsUsdCents)} in sales
                      {' · '}
                      Deleted <time dateTime={snapshot.deletedAt}>{formatWhen(snapshot.deletedAt)}</time>
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          </Surface>
        ) : null}
      </div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  shortLabel,
  value,
  detail,
  foot = null,
}: {
  icon: LucideIcon;
  label: string;
  /** What a phone's narrow tile says in its place. */
  shortLabel?: string;
  value: number;
  detail: string;
  foot?: ReactNode;
}) {
  return (
    <Surface variant="card" padding="none" className="flex min-w-0 flex-col p-3 sm:p-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={clsx('hidden h-8 w-8 shrink-0 items-center justify-center rounded-ui-md border sm:inline-flex', getAccentClasses('neutral').iconWrap)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <Text as="p" variant="label" className="truncate">
          {shortLabel ? (
            <>
              <span className="sm:hidden">{shortLabel}</span>
              <span className="hidden sm:inline">{label}</span>
            </>
          ) : label}
        </Text>
      </div>
      <p className="mt-2 text-2xl font-extrabold leading-8 tracking-tight text-[var(--ui-text-primary)] tabular-nums sm:mt-4 sm:text-4xl sm:leading-10">
        {value.toLocaleString('en-US')}
      </p>
      <Text variant="caption" className="mt-1 hidden sm:block">{detail}</Text>
      {foot ? <p className="mt-auto hidden pt-4 text-xs font-semibold text-[var(--ui-text-muted)] sm:block">{foot}</p> : null}
    </Surface>
  );
}
