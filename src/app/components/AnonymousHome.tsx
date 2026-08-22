import Link from 'next/link';
import { Suspense, use } from 'react';

import { StatusCallout, Text } from '@/app/components/DesignSystem';
import HomeExperience from '@/app/components/HomeExperience';
import HomeSlider from '@/app/components/HomeSlider';
import { JsonLd } from '@/app/components/JsonLd';
import QuickStartsCard from '@/app/components/QuickStartsCard';
import SignInWorkspaceCard from '@/app/components/SignInWorkspaceCard';
import WhatsNewModelsCard from '@/app/components/WhatsNewModelsCard';
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

const FEED_DETAIL_CONTEXT = { from: 'home', returnTo: '/' };

function HomeFeedSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading feed">
      {[220, 320, 260].map((height, index) => (
        <div
          key={index}
          className="relative overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
          style={{ minHeight: height }}
        >
          <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      ))}
    </div>
  );
}

async function AnonymousFeedSection({ data }: { data: Promise<ShowcaseFeedPage | null> }) {
  const feed = await data;

  if (!feed) {
    return (
      <div className="space-y-3">
        <StatusCallout
          tone="danger"
          title="Could not load the community feed"
          body="The creation tools are still available. Check the connection, then try again."
        />
        <Link href="/create" prefetch={false} className="ui-button ui-button-secondary ui-focus-ring">
          Start creating
        </Link>
      </div>
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
      detailContext={FEED_DETAIL_CONTEXT}
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
        The rail replaced the marketing copy that used to carry this heading,
        but the page still needs exactly one h1 — for the document outline
        screen-reader users navigate by, and for the search result this
        statically prerendered page exists to win. Kept in the DOM, out of the
        design.
      */}
      <Text as="h1" variant="display" className="sr-only">
        What will you create today?
      </Text>
      <HomeSlider />
    </div>
  );
}

function AnonymousFooter() {
  return (
    <footer className="relative z-10 border-t border-[var(--ui-border-subtle)] bg-[var(--ui-bg-app)] px-6 py-8 text-sm text-[var(--ui-text-faint)]">
      <div className="studio-shell flex flex-col items-center justify-between gap-4 sm:flex-row">
        <p>© {new Date().getFullYear()} magicbooklet.</p>
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
