import type { Metadata } from 'next';

import { createNoIndexMetadata } from '@/lib/seo';

/**
 * The tab's title, "Alerts | Magic Booklet", which the page cannot name itself: it is a
 * client component, and a page that names none was the bare "Magic Booklet". This layout
 * must never link the signed-in sheet: Alerts draws for a signed-out visitor on
 * globals.css alone, and its signed-in half brings the supplement itself (page.tsx).
 */
export const metadata: Metadata = createNoIndexMetadata(
  'Alerts',
  'Your generation results, recipe purchases, follows, saves, remixes and creator activity on Magic Booklet.'
);

export default function NotificationsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
