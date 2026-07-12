import Link from 'next/link';
import { ArrowRight, Clapperboard, LayoutTemplate, Plus } from 'lucide-react';

import { CreatorToolPreview } from '@/app/components/CreatorToolPreview';
import { CreatorToolCard, SectionHeading } from '@/app/components/CreatorStudio';
import { Kicker, Pill, Text } from '@/app/components/DesignSystem';
import {
  CREATOR_STARTER_RECIPES,
  CREATOR_TOOLS,
  getCreatorTool,
} from '@/lib/creator-tools';
import { loadCreatorToolPreviewMap } from '@/lib/creator-tool-previews';

export default async function CreateHubPage() {
  const previewByTool = await loadCreatorToolPreviewMap();

  return (
    <div className="ui-page ui-page-ambient relative overflow-hidden pb-20 font-[family-name:var(--font-geist-sans)]">
      <div className="studio-shell relative z-10 pt-10 sm:pt-14">
        <section className="ui-enter border-b border-[var(--ui-border-subtle)] pb-8">
          <div className="max-w-3xl">
            <Kicker>Creator launchpad</Kicker>
            <Text as="h1" variant="display" className="mt-4 max-w-[13ch]">
              Choose a format. <span className="text-[var(--ui-primary)]">Start creating.</span>
            </Text>
            <Text variant="bodySm" className="mt-3 max-w-2xl sm:text-base">
              Each path opens with useful defaults. You can tune the model, references, and output after the first decision.
            </Text>
          </div>
        </section>

        <section className="ui-stagger mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {CREATOR_TOOLS.map((tool) => (
            <CreatorToolCard
              key={tool.id}
              tool={tool}
              variant="launchpad"
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
        </section>

        <section className="mt-10">
          <SectionHeading
            eyebrow="Viral templates"
            title="Bring your photo. Keep the format."
            description="Use a published format with your own media and review its checkpoints along the way. Or package your own workflow for everyone to reuse."
            actionHref="/templates"
            actionLabel="Browse all templates"
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(260px,0.75fr)]">
            <Link
              href="/templates"
              className="ui-card ui-card-interactive ui-focus-ring group relative min-h-64 overflow-hidden p-5 sm:p-7"
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_18%,rgba(251,113,133,0.2),transparent_34%),radial-gradient(circle_at_20%_100%,rgba(56,189,248,0.14),transparent_42%)]" />
              <div className="absolute right-6 top-6 hidden items-center gap-2 text-white/25 sm:flex" aria-hidden>
                <div className="h-24 w-16 -rotate-6 rounded-2xl border border-white/10 bg-white/[0.04]" />
                <ArrowRight className="h-5 w-5" />
                <div className="h-24 w-16 rotate-6 rounded-2xl border border-rose-300/20 bg-rose-400/10" />
              </div>
              <div className="relative flex h-full max-w-xl flex-col">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-rose-300/20 bg-rose-400/10 text-rose-100">
                  <Clapperboard className="h-5 w-5" aria-hidden />
                </div>
                <Kicker className="mt-8 text-rose-200/80">Community formats</Kicker>
                <Text as="h3" variant="sectionTitle" className="mt-3 max-w-[18ch]">
                  Turn your inputs into a finished scene.
                </Text>
                <Text variant="bodySm" className="mt-3 max-w-lg sm:text-base">
                  Pick a format, add the requested images or clips, then review its checkpoints as the workflow creates your result.
                </Text>
                <div className="mt-auto inline-flex items-center gap-2 pt-6 text-sm font-semibold text-white">
                  Explore templates
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
                </div>
              </div>
            </Link>

            <Link
              href="/templates/new"
              className="ui-card ui-card-interactive ui-focus-ring group flex min-h-64 flex-col p-5 sm:p-7"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-400/10 text-sky-100">
                  <LayoutTemplate className="h-5 w-5" aria-hidden />
                </div>
                <Plus className="h-5 w-5 text-zinc-500 transition group-hover:rotate-90 group-hover:text-white" aria-hidden />
              </div>
              <Kicker className="mt-8 text-sky-200/80">Template creator</Kicker>
              <Text as="h3" variant="cardTitle" className="mt-3">
                Publish your own format
              </Text>
              <Text variant="bodySm" className="mt-3">
                Build the reusable format on the node canvas, choose consumer uploads, add review gates, then test and publish it.
              </Text>
              <div className="mt-auto inline-flex items-center gap-2 pt-6 text-sm font-semibold text-white">
                Create a template
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
              </div>
            </Link>
          </div>
        </section>

        <section className="mt-10">
          <SectionHeading
            eyebrow="Quick starts"
            title="Try a setup and move."
            actionHref="/showcase"
            actionLabel="Explore showcase"
            variant="minimal"
          />

          <div className="ui-stagger grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {CREATOR_STARTER_RECIPES.map((recipe) => {
              const tool = getCreatorTool(recipe.toolId);

              return (
                <Link
                  key={recipe.id}
                  href={recipe.href}
                  prefetch={
                    tool.id === 'workflow' || tool.id === 'video' ? false : undefined
                  }
                  className="ui-card ui-card-interactive ui-focus-ring group p-4"
                >
                  <Pill accent={recipe.toolId}>{tool.shortLabel}</Pill>
                  <Text as="h3" variant="cardTitle" className="mt-4">
                    {recipe.title}
                  </Text>
                  <Text variant="bodySm" className="mt-2 line-clamp-3">
                    {recipe.description}
                  </Text>
                  <div className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-white">
                    {recipe.ctaLabel}
                    <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
