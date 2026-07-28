import type { Metadata } from 'next';

import MarketingHome from '@/app/components/MarketingHome';
import { createMetadata, siteConfig } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
  title: siteConfig.name,
  absoluteTitle: siteConfig.defaultTitle,
  description:
    'Generate AI images, AI videos, motion-transfer UGC ads, and reusable creative workflows with magicbooklet.',
  path: '/',
});

/**
 * `/` stays a statically prerendered marketing page for cookie-less traffic
 * (SEO bots included). Signed-in browsers never reach this component: the
 * middleware (`src/proxy.ts`) rewrites `/` to the dynamic dashboard at
 * `src/app/home/` when an auth cookie is present. Keep this module's import
 * graph free of `next/headers` and server auth reads — pinned by
 * marketing-home-page-cache.test.tsx.
 */
export const revalidate = 60;

export default function Home() {
  return <MarketingHome />;
}
