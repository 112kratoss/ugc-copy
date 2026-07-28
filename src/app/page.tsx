import type { Metadata } from 'next';

import AnonymousHome from '@/app/components/AnonymousHome';
import { createMetadata, siteConfig } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
  title: siteConfig.name,
  absoluteTitle: siteConfig.defaultTitle,
  description:
    'Generate AI images, AI videos, motion-transfer UGC ads, and reusable creative workflows with magicbooklet.',
  path: '/',
});

/**
 * `/` stays a statically prerendered page for cookie-less traffic (SEO bots
 * included). Signed-in browsers never reach this component: the middleware
 * (`src/proxy.ts`) rewrites `/` to the dynamic dashboard at `src/app/home/`
 * when an auth cookie is present. Both variants render the same feed-first
 * shell (`HomeExperience`); this one swaps the workspace rail card for a
 * sign-in card and adds the marketing hero and legal footer.
 *
 * Keep this module's import graph free of `next/headers`, server auth reads,
 * and `searchParams` — pinned by anonymous-home-page-cache.test.tsx.
 */
export const revalidate = 60;

export default function Home() {
  return <AnonymousHome />;
}
