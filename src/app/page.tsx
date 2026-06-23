import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { CreatorToolPreview } from '@/app/components/CreatorToolPreview';
import { CreatorToolCard, SectionHeading } from '@/app/components/CreatorStudio';
import { SectionHeader, Text } from '@/app/components/DesignSystem';
import DeferredHomeShowcasePreviewGrid from '@/app/components/DeferredHomeShowcasePreviewGrid';
import { JsonLd } from '@/app/components/JsonLd';
import { CREATOR_TOOLS } from '@/lib/creator-tools';
import { loadCreatorToolPreviewMap } from '@/lib/creator-tool-previews';
import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from '@/lib/pricing';
import {
  buildOrganizationSchema,
  buildSoftwareApplicationSchema,
  createMetadata,
  siteConfig,
} from '@/lib/seo';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';

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
    name: IMAGE_MODELS['grok-imagine-image'].displayName,
    description: 'xAI multi-output image runs',
    href: '/create-image?model=grok-imagine-image',
    accent: 'from-amber-500/20 to-orange-400/10',
  },
  {
    name: VIDEO_MODELS['grok-imagine-video'].displayName,
    description: 'xAI prompt and image-to-video',
    href: '/create-video?model=grok-imagine-video',
    accent: 'from-rose-500/20 to-amber-400/10',
  },
  {
    name: IMAGE_MODELS['gpt-image-2'].displayName,
    description: 'ChatGPT image generation',
    href: '/create-image?model=gpt-image-2',
    accent: 'from-amber-500/20 to-orange-400/10',
  },
  {
    name: IMAGE_MODELS['nano-banana-pro'].displayName,
    description: 'High-fidelity stills',
    href: '/create-image?model=nano-banana-pro',
    accent: 'from-violet-500/20 to-fuchsia-400/10',
  },
  {
    name: VIDEO_MODELS['kling-3.0-video'].displayName,
    description: 'Cinematic video scenes',
    href: '/create-video?model=kling-3.0-video',
    accent: 'from-rose-500/20 to-orange-400/10',
  },
  {
    name: MOTION_MODELS['kling-3.0'].displayName,
    description: 'Motion-led UGC output',
    href: '/create-motion?model=kling-3.0',
    accent: 'from-violet-500/20 to-indigo-400/10',
  },
] as const;

export default async function Home() {
  const showcaseFeed = await getShowcaseFeedPage({
    category: 'all',
    sort: 'top-saves',
    offset: 0,
    limit: 12,
    viewerUserId: null,
    countryCode: null,
  });
  const previewByTool = await loadCreatorToolPreviewMap({
    viewerUserId: null,
    seedItems: showcaseFeed.items,
  });

  return (
    <div className="ui-page relative flex flex-col overflow-hidden font-[family-name:var(--font-geist-sans)]">
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

      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[10%] top-20 h-48 w-48 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="absolute right-[12%] top-24 h-64 w-64 rounded-full bg-fuchsia-500/10 blur-3xl" />
      </div>

      <main className="studio-shell relative z-10 flex flex-1 flex-col pb-24 pt-8 sm:pt-12">
        <section className="flex flex-col items-center text-center">
          <Text as="h1" variant="display" className="max-w-3xl">
            What would you like to{' '}
            <span className="bg-gradient-to-r from-pink-400 via-fuchsia-400 to-violet-300 bg-clip-text text-transparent">
              create
            </span>{' '}
            today?
          </Text>
          <Text variant="bodySm" className="mt-4 max-w-2xl sm:text-base">
            Pick a path, see the output style immediately, and move straight into creation.
          </Text>

          <div className="ui-surface-soft mt-6 grid w-full max-w-[880px] grid-cols-2 gap-2 rounded-3xl p-2 sm:grid-cols-4">
            {CREATOR_TOOLS.map((tool) => {
              const Icon = tool.icon;

              return (
                <Link
                  key={tool.id}
                  href={tool.href}
                  prefetch={
                    tool.id === 'workflow' || tool.id === 'video' ? false : undefined
                  }
                  className="flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                >
                  <Icon className="h-4 w-4" />
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
            align="center"
            compact
            className="mb-5"
          />

          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            {CREATOR_TOOLS.map((tool) => (
              <CreatorToolCard
                key={tool.id}
                tool={tool}
                variant="suite"
                preview={
                  previewByTool[tool.id] ? (
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
        </section>

        <section className="mt-12 w-full">
          <SectionHeading
            eyebrow="Latest models"
            title="Choose the engine."
            variant="minimal"
          />

          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            {LATEST_MODELS.map((model) => (
              <Link
                key={model.name}
                href={model.href}
                prefetch={model.href.includes('/create-video') ? false : undefined}
                className="ui-card ui-card-interactive ui-focus-ring group overflow-hidden p-3.5"
              >
                <div
                  className={`flex h-36 w-full items-end rounded-2xl bg-gradient-to-br p-5 ${model.accent}`}
                >
                  <div className="text-2xl font-semibold text-white/90">
                    {model.name}
                  </div>
                </div>
                <Text variant="bodySm" className="px-1 pb-1 pt-4">{model.description}</Text>
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

          <DeferredHomeShowcasePreviewGrid
            items={showcaseFeed.items}
            initialSession={null}
            initialCredits={null}
          />
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/[0.04] bg-black/70 px-6 py-8 text-center text-sm text-zinc-600 backdrop-blur-sm">
        <p>© {new Date().getFullYear()} magicbooklet. All rights reserved.</p>
      </footer>
    </div>
  );
}
