import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Suspense, use } from 'react';

import { CreatorToolPreview } from '@/app/components/CreatorToolPreview';
import { CreatorToolCard, SectionHeading } from '@/app/components/CreatorStudio';
import { Button, getAccentClasses, Kicker, SectionHeader, StatusCallout, Text } from '@/app/components/DesignSystem';
import DeferredHomeShowcasePreviewGrid from '@/app/components/DeferredHomeShowcasePreviewGrid';
import { JsonLd } from '@/app/components/JsonLd';
import { CREATOR_TOOLS } from '@/lib/creator-tools';
import {
  buildCreatorToolPreviewMap,
  loadCreatorToolPreviewMap,
} from '@/lib/creator-tool-previews';
import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from '@/lib/pricing';
import {
  buildOrganizationSchema,
  buildSoftwareApplicationSchema,
  createMetadata,
  siteConfig,
} from '@/lib/seo';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

export const metadata: Metadata = createMetadata({
  title: siteConfig.name,
  absoluteTitle: siteConfig.defaultTitle,
  description:
    'Generate AI images, AI videos, motion-transfer UGC ads, and reusable creative workflows with magicbooklet.',
  path: '/',
});

export const revalidate = 60;

const LATEST_MODELS = [
  {
    name: IMAGE_MODELS['seedream-5-pro'].displayName,
    description: 'Production-ready stills and edits',
    href: '/create-image?model=seedream-5-pro',
    accent: 'border-sky-300/15 bg-sky-400/[0.07] text-sky-100',
  },
  {
    name: VIDEO_MODELS['grok-imagine-video'].displayName,
    description: 'xAI prompt and image-to-video',
    href: '/create-video?model=grok-imagine-video',
    accent: 'border-rose-300/15 bg-rose-400/[0.07] text-rose-100',
  },
  {
    name: IMAGE_MODELS['nano-banana-2-lite'].displayName,
    description: 'Fast, affordable 1K image runs',
    href: '/create-image?model=nano-banana-2-lite',
    accent: 'border-cyan-300/15 bg-cyan-400/[0.07] text-cyan-100',
  },
  {
    name: IMAGE_MODELS['flux-2-pro'].displayName,
    description: 'Photoreal multi-reference product work',
    href: '/create-image?model=flux-2-pro',
    accent: 'border-sky-300/15 bg-sky-400/[0.07] text-sky-100',
  },
  {
    name: VIDEO_MODELS['kling-3.0-video'].displayName,
    description: 'Cinematic video scenes',
    href: '/create-video?model=kling-3.0-video',
    accent: 'border-rose-300/15 bg-rose-400/[0.07] text-rose-100',
  },
  {
    name: MOTION_MODELS['kling-3.0'].displayName,
    description: 'Motion-led UGC output',
    href: '/create-motion?model=kling-3.0',
    accent: 'border-white/10 bg-white/[0.04] text-[var(--ui-accent-motion)]',
  },
] as const;

function createEmptyHomeShowcaseFeed(): ShowcaseFeedPage {
  return {
    items: [],
    availableTools: [],
    pageInfo: {
      hasMore: false,
      nextOffset: null,
      limit: 12,
      offset: 0,
    },
  };
}

async function loadHomeShowcaseFeed(): Promise<{
  feed: ShowcaseFeedPage;
  usedFallback: boolean;
}> {
  try {
    return {
      feed: await getShowcaseFeedPage({
        category: 'all',
        sort: 'top-saves',
        offset: 0,
        limit: 12,
        viewerUserId: null,
        countryCode: null,
      }),
      usedFallback: false,
    };
  } catch (error) {
    console.error('Failed to load homepage showcase content:', error);
    return {
      feed: createEmptyHomeShowcaseFeed(),
      usedFallback: true,
    };
  }
}

async function loadHomeCreatorToolPreviewMap({
  seedItems,
  skipRemoteFallback,
}: {
  seedItems: ShowcaseFeedItem[];
  skipRemoteFallback: boolean;
}) {
  if (skipRemoteFallback) {
    return buildCreatorToolPreviewMap(seedItems);
  }

  try {
    return await loadCreatorToolPreviewMap({
      viewerUserId: null,
      seedItems,
    });
  } catch (error) {
    console.error('Failed to load homepage creator tool previews:', error);
    return buildCreatorToolPreviewMap(seedItems);
  }
}

type HomePageData = {
  showcaseFeed: ShowcaseFeedPage;
  usedFallback: boolean;
  previewByTool: Awaited<ReturnType<typeof loadHomeCreatorToolPreviewMap>>;
};

async function loadHomePageData(): Promise<HomePageData> {
  const { feed: showcaseFeed, usedFallback } = await loadHomeShowcaseFeed();
  const previewByTool = await loadHomeCreatorToolPreviewMap({
    seedItems: showcaseFeed.items,
    skipRemoteFallback: usedFallback,
  });

  return {
    showcaseFeed,
    usedFallback,
    previewByTool,
  };
}

function HomeCreatorSuiteFallback() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Loading creator previews">
      {CREATOR_TOOLS.map((tool) => (
        <CreatorToolCard
          key={tool.id}
          tool={tool}
          variant="suite"
          prefetch={false}
        />
      ))}
    </div>
  );
}

function HomeCreatorSuite({ data }: { data: Promise<HomePageData> }) {
  const { previewByTool } = use(data);

  return (
    <div className="ui-stagger grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {CREATOR_TOOLS.map((tool, index) => (
        <CreatorToolCard
          key={tool.id}
          tool={tool}
          variant="suite"
          prefetch={false}
          preview={
            // The first mobile card sits inside the initial viewport. Keep its
            // branded gradient stable so a deferred remote image cannot replace
            // the already-painted hero as the page's LCP.
            index > 0 && previewByTool[tool.id] ? (
              <CreatorToolPreview
                item={previewByTool[tool.id]}
                alt={tool.label}
                className="h-full w-full object-cover opacity-90 transition duration-300 group-hover:opacity-100"
              />
            ) : undefined
          }
        />
      ))}
    </div>
  );
}

function HomeInspirationsFallback() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5" aria-label="Loading Showcase posts">
      {[180, 240, 210, 270, 200].map((height, index) => (
        <div
          key={index}
          className="relative overflow-hidden rounded-[24px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
          style={{ minHeight: height }}
        >
          <div className="absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      ))}
    </div>
  );
}

function HomeInspirations({ data }: { data: Promise<HomePageData> }) {
  const { showcaseFeed, usedFallback } = use(data);

  if (usedFallback) {
    return (
      <div className="space-y-3">
        <StatusCallout
          tone="danger"
          title="Could not load the Showcase"
          body="Your creation tools are still available. Check the connection, then try the Showcase again."
        />
        <Link href="/?retryFeed=1" prefetch={false} className="ui-button ui-button-secondary ui-focus-ring">Retry Showcase</Link>
      </div>
    );
  }

  return (
    <DeferredHomeShowcasePreviewGrid
      items={showcaseFeed.items}
      initialSession={null}
      initialCredits={null}
    />
  );
}

export default function Home() {
  const homePageData = loadHomePageData();

  return (
    <div className="ui-page ui-page-ambient relative flex flex-col overflow-hidden font-[family-name:var(--font-geist-sans)]">
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

      <main className="studio-shell relative z-10 flex flex-1 flex-col pb-24 pt-7 sm:pt-10">
        <section className="grid gap-8 border-b border-[var(--ui-border-subtle)] pb-10 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.78fr)] lg:items-end">
          <div className="max-w-3xl">
            <Kicker icon={Sparkles}>Obsidian creator studio</Kicker>
            <Text as="h1" variant="display" className="mt-4 max-w-[13ch]">
              What will you create <span className="text-[var(--ui-primary)]">today?</span>
            </Text>
            <Text variant="bodySm" className="mt-4 max-w-xl sm:text-base">
              Choose a format, start with a strong default, and move from idea to output without the setup maze.
            </Text>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button href="/create" variant="primary" icon={ArrowRight}>
                Start creating
              </Button>
              <Button href="/showcase" prefetch={false} variant="secondary">
                Browse Showcase
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-[28px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-2 sm:grid-cols-4 lg:grid-cols-2">
            {CREATOR_TOOLS.map((tool) => {
              const Icon = tool.icon;
              const theme = getAccentClasses(tool.accent);

              return (
                <Link
                  key={tool.id}
                  href={tool.href}
                  prefetch={false}
                  className="ui-focus-ring group flex min-h-14 items-center gap-3 rounded-[20px] border border-transparent px-3 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:border-[var(--ui-border-subtle)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
                >
                  <span className={`flex h-9 w-9 items-center justify-center rounded-[13px] border transition ${theme.iconWrap}`}>
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  {tool.shortLabel}
                </Link>
              );
            })}
          </div>
        </section>

        <section className="mt-10 w-full">
          <SectionHeader
            eyebrow="Creator suite"
            title="Core creator paths"
            actionHref="/create"
            actionLabel="Launchpad"
            actionIcon={ArrowRight}
            actionPrefetch={false}
            align="center"
            compact
            className="mb-5"
          />

          <Suspense fallback={<HomeCreatorSuiteFallback />}>
            <HomeCreatorSuite data={homePageData} />
          </Suspense>
        </section>

        <section className="mt-12 w-full">
          <SectionHeading
            eyebrow="Latest models"
            title="Choose the engine."
            variant="minimal"
          />

          <div className="ui-stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {LATEST_MODELS.map((model) => (
              <Link
                key={model.name}
                href={model.href}
                prefetch={false}
                className="ui-card ui-card-interactive ui-focus-ring group flex min-h-28 items-center justify-between gap-5 overflow-hidden p-5"
              >
                <div
                  className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border ${model.accent}`}
                >
                  <Sparkles className="h-5 w-5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <Text as="h3" variant="cardTitle" className="truncate text-lg">{model.name}</Text>
                  <Text variant="bodySm" className="mt-1 line-clamp-2">{model.description}</Text>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-[var(--ui-text-faint)] transition group-hover:translate-x-0.5 group-hover:text-[var(--ui-primary)]" aria-hidden />
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-12 w-full">
          <SectionHeading
            eyebrow="Inspirations"
            title="See what creators are already making."
            actionHref="/showcase"
            actionLabel="Showcase"
            variant="minimal"
          />

          <Suspense fallback={<HomeInspirationsFallback />}>
            <HomeInspirations data={homePageData} />
          </Suspense>
        </section>
      </main>

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
    </div>
  );
}
