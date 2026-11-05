import type { Metadata } from 'next';

import AnonymousHome from '@/components/AnonymousHome';
import { createMetadata, siteConfig } from '@/lib/seo';

/**
 * The title is the brand and its line, "Create, share and earn" (owner,
 * 2026-11-05), followed by what a person makes here, so the page still names
 * something a person searches for. It replaced "AI Video, Image & Motion
 * Transfer for UGC Ads": the product is more than an ad maker. The tagline is
 * the hero's h1 (`AnonymousHome`, since 2026-10-31), so this title and the
 * description below are where the page names what the product does; a test
 * holds both to those words.
 */
export const metadata: Metadata = createMetadata({
  title: siteConfig.name,
  absoluteTitle: `${siteConfig.name}: Create, share and earn with AI video & images`,
  description:
    'Make AI videos, AI images and motion transfer with Magic Booklet, share them with other creators, and earn by selling the recipes behind them.',
  path: '/',
  keywords: [
    'AI video generator',
    'AI image generator',
    'AI motion transfer',
    'AI creator community',
    'sell AI prompts',
  ],
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
 *
 * Rebuilt at most every 15 minutes (`ANONYMOUS_HOME_REVALIDATE_SECONDS`;
 * Next needs the literal here), and at the next visit after any change that
 * invalidates the feed's tag, which its reads carry (`anonymous-home-data.ts`).
 * At 60 seconds, Sentry's once-a-minute uptime check rebuilt it about 8,200
 * times a week, most of the Vercel usage.
 */
export const revalidate = 900;

export default function Home() {
  return <AnonymousHome />;
}
