'use client';

import { UserRound } from 'lucide-react';

import { Button, Surface, Text } from '@/components/DesignSystem';
import { formatRecipeCreditPrice } from '@/lib/showcase-asset-labels';
import { getUserInitials } from '@/lib/user-initials';

import type { SellerRecipeCandidateView } from './RecipeCandidatePicker';
import SellerRecipeCover from './SellerRecipeCover';
import { buildAddRecipeHref, formatPostEngagement } from './seller-recipes';

export interface SellerRecipeUnlockView {
  id: string;
  bundleId: string;
  buyerLabel: string;
  /** Whether `buyerLabel` names someone; "Someone" when it does not. */
  named: boolean;
  paid: boolean;
  /** A sale paid with credits: `amountSubunits` is its price in credits. */
  paidInCredits: boolean;
  amountSubunits: number;
  currency: 'INR' | 'USD';
  createdAt: string;
}

/** How many of the posts without a recipe the column suggests; the picker lists the rest. */
const SUGGESTED_POSTS = 3;

// A fixed locale: the default one is the server's on the server and the
// seller's in the browser.
function formatUnlockAmount(amountSubunits: number, currency: SellerRecipeUnlockView['currency']): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountSubunits / 100);
}

/** Who unlocked which recipe, newest first: free ones were opened, paid ones bought. */
export function RecentUnlocks({
  unlocks,
  recipeTitleFor,
  formatWhen,
}: {
  unlocks: SellerRecipeUnlockView[];
  recipeTitleFor: (bundleId: string) => string;
  formatWhen: (value: string) => string;
}) {
  return (
    <Surface as="section" variant="card" padding="lg">
      <Text as="h2" variant="cardTitle">Recent unlocks</Text>
      {unlocks.length > 0 ? (
        <ul className="mt-2 divide-y divide-[var(--ui-border-subtle)]">
          {unlocks.map((unlock) => (
            <li key={unlock.id} className="flex gap-3 py-3">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ui-surface-3)] text-xs font-bold text-[var(--ui-text-secondary)]"
              >
                {/* A character, not a UTF-16 unit (getUserInitials): half an
                    emoji drew U+FFFD on the server and failed hydration. */}
                {unlock.named
                  ? getUserInitials(unlock.buyerLabel.replace(/^@/, ''))
                  : <UserRound className="h-4 w-4" />}
              </span>
              <div className="min-w-0 text-sm leading-5">
                <p className="line-clamp-2 text-[var(--ui-text-muted)]">
                  <span className="font-semibold text-[var(--ui-text-primary)]">{unlock.buyerLabel}</span>
                  {unlock.paid ? ' bought ' : ' opened '}
                  <span className="text-[var(--ui-text-secondary)]">{recipeTitleFor(unlock.bundleId)}</span>
                </p>
                <p className="mt-0.5 text-xs font-semibold text-[var(--ui-text-faint)]">
                  <time dateTime={unlock.createdAt}>{formatWhen(unlock.createdAt)}</time>
                  {' · '}
                  {!unlock.paid
                    ? 'Free'
                    : unlock.paidInCredits
                      ? formatRecipeCreditPrice(unlock.amountSubunits)
                      : formatUnlockAmount(unlock.amountSubunits, unlock.currency)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Text variant="bodySm" className="mt-2">
          Nobody has unlocked a recipe yet. Share a recipe’s link to bring the first one in.
        </Text>
      )}
    </Surface>
  );
}

/** The seller's most-saved posts without a recipe, each with a way to add one. */
export function ReadyForRecipe({ candidates }: { candidates: SellerRecipeCandidateView[] }) {
  if (candidates.length === 0) return null;

  return (
    <Surface as="section" variant="card" padding="lg">
      <Text as="h2" variant="cardTitle">Ready for a recipe</Text>
      <Text variant="bodySm" className="mt-1">Your most-saved posts that have no recipe yet.</Text>
      <ul className="mt-2 divide-y divide-[var(--ui-border-subtle)]">
        {candidates.slice(0, SUGGESTED_POSTS).map((candidate) => (
          <li key={candidate.postId} className="flex items-center gap-3 py-3">
            <SellerRecipeCover post={candidate} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[var(--ui-text-primary)]">{candidate.title}</p>
              <p className="mt-0.5 text-xs font-medium text-[var(--ui-text-faint)]">{formatPostEngagement(candidate)}</p>
            </div>
            <Button
              href={buildAddRecipeHref(candidate.postId)}
              prefetch={false}
              variant="secondary"
              ariaLabel={`Add a recipe to ${candidate.title}`}
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
    </Surface>
  );
}
