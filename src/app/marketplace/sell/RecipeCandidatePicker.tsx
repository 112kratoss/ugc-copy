'use client';

import Link from 'next/link';
import { FilePlus2 } from 'lucide-react';

import { Button, Text } from '@/components/DesignSystem';

import SellerRecipeCover from './SellerRecipeCover';
import { SELLER_NEW_POST_HREF, buildAddRecipeHref, formatPostEngagement } from './seller-recipes';

export interface SellerRecipeCandidateView {
  postId: string;
  title: string;
  postFormat?: string;
  mediaKind?: string | null;
  mediaUrl?: string | null;
  mediaPreviewUrl?: string | null;
  saveCount?: number;
  remixCount?: number;
  shareVisitCount?: number;
}

/**
 * The seller's posts that have no recipe, each opening its editor to add one,
 * and the composer for a post that is not up yet. `candidates` is null when
 * they could not be read; `emptyText` says what no candidates means where the
 * picker is drawn.
 */
export default function RecipeCandidatePicker({
  candidates,
  emptyText,
}: {
  candidates: SellerRecipeCandidateView[] | null;
  emptyText: string;
}) {
  return (
    <>
      {candidates && candidates.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {candidates.map((candidate) => (
            <li key={candidate.postId}>
              <Link
                href={buildAddRecipeHref(candidate.postId)}
                prefetch={false}
                aria-label={`Add a recipe to ${candidate.title}`}
                className="ui-focus-ring flex min-h-16 items-center gap-3 rounded-ui-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-3 transition-colors duration-150 hover:border-[var(--ui-border-strong)] hover:bg-[var(--ui-surface-2)]"
              >
                <SellerRecipeCover post={candidate} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-[var(--ui-text-primary)]">{candidate.title}</span>
                  <span className="mt-0.5 block text-xs font-medium text-[var(--ui-text-faint)]">{formatPostEngagement(candidate)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Text variant="bodySm">
          {candidates ? emptyText : 'Your posts could not be loaded. Reload the page to try again.'}
        </Text>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--ui-border-subtle)] pt-5">
        <Text variant="bodySm">Or start from work that isn’t posted yet.</Text>
        <Button href={SELLER_NEW_POST_HREF} prefetch={false} variant="secondary" icon={FilePlus2} iconPosition="start">
          Share a new post
        </Button>
      </div>
    </>
  );
}
