import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { ArrowRight } from 'lucide-react';

import { AuthProvider } from '@/app/components/AuthProvider';
import { CreatorToolPreview } from '@/app/components/CreatorToolPreview';
import { CreatorToolCard, SectionHeading } from '@/app/components/CreatorStudio';
import HomeShowcasePreviewGrid from '@/app/components/HomeShowcasePreviewGrid';
import { JsonLd } from '@/app/components/JsonLd';
import { CREATOR_TOOLS } from '@/lib/creator-tools';
import { loadCreatorToolPreviewMap } from '@/lib/creator-tool-previews';
import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from '@/lib/pricing';
import {
  buildOrganizationSchema,
  buildSoftwareApplicationSchema,
  createMetadata,
  siteConfig,
} from '@/lib/seo';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import { getServerAuthState } from '@/lib/supabase-server';

export const metadata: Metadata = createMetadata({
  title: siteConfig.name,
  absoluteTitle: siteConfig.defaultTitle,
  description:
    'Generate AI images, AI videos, motion-transfer UGC ads, and reusable creative workflows with magicbooklet.',
  path: '/',
});

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

async function getOptionalRequestCountryCode() {
  try {
    const headerStore = await headers();
    return headerStore.get('x-vercel-ip-country');
  } catch {
    return null;
  }
}

export default async function Home() {
  const auth = await getServerAuthState();
  const countryCode = await getOptionalRequestCountryCode();
  const showcaseFeed = await getShowcaseFeedPage({
    category: 'all',
    sort: 'top-saves',
    offset: 0,
    limit: 12,
    viewerUserId: auth.session?.user?.id ?? null,
    countryCode,
  });
  const previewByTool = await loadCreatorToolPreviewMap({
    viewerUserId: auth.session?.user?.id ?? null,
    seedItems: showcaseFeed.items,
  });

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-black text-white font-[family-name:var(--font-geist-sans)]">
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
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl md:text-[3.85rem]">
            What would you like to{' '}
            <span className="bg-gradient-to-r from-pink-400 via-fuchsia-400 to-violet-300 bg-clip-text text-transparent">
              create
            </span>{' '}
            today?
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400 sm:text-base">
            Pick a path, see the output style immediately, and move straight into creation.
          </p>

          <div className="mt-6 grid w-full max-w-[880px] grid-cols-2 gap-2 rounded-[28px] border border-white/8 bg-white/[0.03] p-2 sm:grid-cols-4">
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
          <div className="mb-5 flex flex-col items-center text-center">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-zinc-500">
              Creator suite
            </div>
            <h2 className="text-[1.85rem] font-semibold tracking-tight text-white sm:text-[2.2rem]">
              Core creator paths
            </h2>
            <Link
              href="/create"
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-100 transition hover:bg-white/[0.06]"
            >
              Launchpad
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

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
                className="group overflow-hidden rounded-[26px] border border-white/8 bg-[#111215] p-3.5 transition hover:border-white/12"
              >
                <div
                  className={`flex h-36 w-full items-end rounded-[20px] bg-gradient-to-br p-5 ${model.accent}`}
                >
                  <div className="text-2xl font-semibold tracking-tight text-white/90">
                    {model.name}
                  </div>
                </div>
                <p className="px-1 pb-1 pt-4 text-sm text-zinc-400">{model.description}</p>
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

          <AuthProvider
            initialSession={auth.session}
            initialCredits={auth.credits}
            hasResolvedInitialState
          >
            <HomeShowcasePreviewGrid items={showcaseFeed.items} />
          </AuthProvider>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/[0.04] bg-black/70 px-6 py-8 text-center text-sm text-zinc-600 backdrop-blur-sm">
        <p>© {new Date().getFullYear()} magicbooklet. All rights reserved.</p>
      </footer>
    </div>
  );
}
