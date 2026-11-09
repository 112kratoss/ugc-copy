import type { Metadata } from 'next';

import '@/app/non-public-utilities.css';

import { RequestHintedOptionalAuth } from '@/components/RouteAuthBoundary';
import { createNoIndexMetadata } from '@/lib/seo';

/**
 * The creator-name step, for a signed-in account only (the page sends anyone
 * else to sign in), so it is never indexed. The optional-auth boundary gives
 * the step the verified session it checks and saves the handle with.
 */
export const metadata: Metadata = createNoIndexMetadata(
  'Claim your creator name',
  'Choose the name and handle people will see on your posts, profile, and recipes.'
);

export default function CreatorNameStepLayout({ children }: { children: React.ReactNode }) {
  return <RequestHintedOptionalAuth>{children}</RequestHintedOptionalAuth>;
}
