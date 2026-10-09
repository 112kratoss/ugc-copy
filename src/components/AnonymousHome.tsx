import Link from 'next/link';
import { Suspense, use } from 'react';

import { Text } from '@/components/DesignSystem';
import { HOME_FEED_DETAIL_CONTEXT, HomeFeedSkeleton } from '@/components/HomeFeedSkeleton';
import HomeExperience from '@/components/HomeExperience';
import HomeSlider from '@/components/HomeSlider';
import { JsonLd } from '@/components/JsonLd';
import QuickStartsCard from '@/components/QuickStartsCard';
import SignInWorkspaceCard from '@/components/SignInWorkspaceCard';
import WhatsNewModelsCard from '@/components/WhatsNewModelsCard';
import FeedClient from '@/app/feed/FeedClient';
import type { HomeWhatsNewModel } from '@/lib/home-dashboard';
import { loadHomeFeed, loadHomeWhatsNewModels } from '@/lib/home-dashboard-service';
import { getFeedChip } from '@/lib/post-feed-chips';
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from '@/lib/pricing';
import { getInlineShowcasePriorityPoster } from '@/lib/showcase-priority-poster';
import {
  buildOrganizationSchema,
  buildSoftwareApplicationSchema,
  siteConfig,
} from '@/lib/seo';
import type { ShowcaseFeedPage } from '@/lib/showcase';

/**
 * The signed-out `/`. Same shell as the signed-in dashboard — community feed
 * in the center, context rail on the right — so the product looks like itself
 * before anyone signs in. A compact hero keeps the page's search-visible
 * promise and the conversion path above the feed.
 *
 * Everything here must stay statically prerenderable: no cookies, no headers,
 * no server auth reads, and no `searchParams` (feed lane switching happens
 * client-side inside FeedClient). Pinned by anonymous-home-page-cache.test.tsx.
 */

async function AnonymousFeedSection({ data }: { data: Promise<ShowcaseFeedPage | null> }) {
  const feed = await data;

  if (!feed) {
    // The loader failed during this render. This page is cached and shared, so
    // an error baked into it would greet every visitor until the next
    // regeneration; the client lane fetches page one itself instead, with a
    // Retry that works in the browser.
    return (
      <FeedClient
        initialFeed={null}
        initialChipId="for-you"
        variant="embedded"
        detailContext={HOME_FEED_DETAIL_CONTEXT}
      />
    );
  }

  const priorityPost = feed.items[0] ?? null;
  const priorityMedia = priorityPost?.mediaItems
    ?.slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)[0] ?? null;
  const inlinePriorityPreview = priorityMedia?.previewUrl
    ? await getInlineShowcasePriorityPoster(priorityMedia.previewUrl)
    : null;

  return (
    <FeedClient
      initialFeed={feed}
      initialChipId="for-you"
      variant="embedded"
      detailContext={HOME_FEED_DETAIL_CONTEXT}
      initialPriorityPreview={priorityPost && priorityMedia && inlinePriorityPreview
        ? {
            postId: priorityPost.id,
            mediaId: priorityMedia.id,
            dataUrl: inlinePriorityPreview,
          }
        : null}
    />
  );
}

function AnonymousModelsSection({ data }: { data: Promise<HomeWhatsNewModel[]> }) {
  return <WhatsNewModelsCard models={use(data)} />;
}

function AnonymousHero() {
  // A plain div, not <header>: inside <main> the browser maps <header> to a
  // second `banner` landmark, which competes with the app shell's real one.
  return (
    <div>
      {/*
        The page needs exactly one h1 — for the document outline screen-reader
        users navigate by, and for the search result this statically
        prerendered page exists to win.

        It used to be `sr-only` and read "What will you create today?", which
        gave a crawler nothing: the only visible headings on `/` are feed post
        titles, so the highest-authority page in the site was being read as a
        page about whatever someone last published. Visible and compact, above
        the slider, so it states the category without taking the space the feed
        is meant to occupy.
      */}
      <div className="mb-6 space-y-2">
        <Text as="h1" variant="pageTitle" className="max-w-3xl text-3xl sm:text-4xl">
          Create AI videos, images, and motion-transfer UGC ads
        </Text>
        <Text variant="body" className="max-w-2xl">
          {siteConfig.tagline}
        </Text>
      </div>
      <HomeSlider />
    </div>
  );
}

function AnonymousFooter() {
  return (
    <footer className="relative z-10 border-t border-[var(--ui-border-subtle)] bg-[var(--ui-bg-app)] px-6 py-8 text-sm text-[var(--ui-text-faint)]">
      <div className="studio-shell flex flex-col items-center justify-between gap-4 sm:flex-row">
        <p>© {new Date().getFullYear()} magicbooklet.</p>
        {/* The model price list, comparisons, guides and feature pages were
            reachable only through sitemap.xml. */}
        <nav className="flex flex-wrap justify-center gap-x-5 gap-y-2" aria-label="Product">
          <Link href="/models" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Models</Link>
          <Link href="/alternatives" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Compare</Link>
          <Link href="/blog" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Blog</Link>
          <Link href="/ai-image-generator" prefetch={false} className="hover:text-[var(--ui-text-primary)]">AI images</Link>
          <Link href="/ai-video-generator" prefetch={false} className="hover:text-[var(--ui-text-primary)]">AI video</Link>
          <Link href="/ai-motion-transfer" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Motion transfer</Link>
          <Link href="/ai-workflow-builder" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Workflows</Link>
        </nav>
        <nav className="flex flex-wrap justify-center gap-x-5 gap-y-2" aria-label="Legal and support">
          <Link href="/contact" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Contact</Link>
          <Link href="/child-safety" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Child safety</Link>
          <Link href="/privacy" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Privacy</Link>
          <Link href="/terms" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Terms</Link>
          <Link href="/cancellation" prefetch={false} className="hover:text-[var(--ui-text-primary)]">Cancellation</Link>
        </nav>
      </div>
    </footer>
  );
}

export default function AnonymousHome() {
  const feedPromise = loadHomeFeed({ viewerUserId: null, chip: getFeedChip(undefined) });
  const modelsPromise = loadHomeWhatsNewModels();

  return (
    <>
      <JsonLd data={buildOrganizationSchema()} />
      <JsonLd
        data={buildSoftwareApplicationSchema({
          name: siteConfig.name,
          path: '/',
          description:
            'magicbooklet helps teams generate AI images, AI videos, motion-transfer ads, and reusable creative workflows.',
          featureList: ['AI images', 'AI videos', 'Motion transfer', 'Workflows'],
          offers: [
            {
              name: `${PRICING_PLAN_MAP.starter.name} credits`,
              price: PRICING_PLAN_MAP.starter.priceInr,
              priceCurrency: PRICING_CURRENCY,
            },
          ],
        })}
      />

      <HomeExperience
        hero={<AnonymousHero />}
        inlineStrip={<SignInWorkspaceCard variant="inline" />}
        feed={(
          <Suspense fallback={<HomeFeedSkeleton />}>
            <AnonymousFeedSection data={feedPromise} />
          </Suspense>
        )}
        rail={(
          <>
            <SignInWorkspaceCard />
            <QuickStartsCard />
            <Suspense fallback={null}>
              <AnonymousModelsSection data={modelsPromise} />
            </Suspense>
          </>
        )}
        footer={<AnonymousFooter />}
      />
    </>
  );
}
