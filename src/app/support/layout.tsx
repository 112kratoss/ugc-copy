import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequestHintedOptionalAuth } from '@/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

export const metadata: Metadata = createNoIndexMetadata(
  'Help & Support',
  'Message Magic Booklet support, read news from the team and see what we are building next.'
);

/**
 * Everyone opens Help & Support (owner, 2026-11-26): a visitor reads Updates
 * and the Roadmap, and its Chat tab asks them to sign in. A browser with a
 * session cookie is drawn with the session the server verified, so the chat,
 * or the sign-in prompt in its place, is right from the first paint.
 *
 * It keeps the signed-in sheet, as the creators do for the visitors they draw
 * for: its chat is the account's, and the page is not indexed.
 */
export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
