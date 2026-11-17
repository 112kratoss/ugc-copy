import type { Metadata } from 'next';

import { RequestHintedOptionalAuth } from '@/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

/**
 * The tab reads "Recipe sales | Magic Booklet", the page's own heading, as every signed-in page is
 * named after its own (live sweep, 2026-11-17: it read "Magic Booklet" alone, since the
 * storefront's title is its page's, not this folder's). Kept out of search results, as a seller's
 * own page.
 */
export const metadata: Metadata = createNoIndexMetadata(
  'Recipe sales',
  'Your recipes on Magic Booklet: what each one earns, its unlocks, saves and link visits, and your payouts.'
);

/**
 * Recipe sales is a signed-in page that reads the session on every request
 * anyway, so it keeps drawing with the session the server checked, as
 * `marketplace/layout.tsx` did for every marketplace page until the storefront
 * was cached for everyone.
 */
export default function MarketplaceSellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
