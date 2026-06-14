import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

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
    <div className="ui-page relative overflow-hidden pb-20 font-[family-name:var(--font-geist-sans)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[10%] top-20 h-52 w-52 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="absolute right-[10%] top-20 h-64 w-64 rounded-full bg-fuchsia-500/10 blur-3xl" />
      </div>

      <div className="studio-shell relative z-10 pt-10 sm:pt-14">
        <section>
          <div className="max-w-3xl">
            <Kicker>Creator launchpad</Kicker>
            <Text as="h1" variant="display" className="mt-4 max-w-[14ch]">
              Pick the path that gets you to a first output fastest.
            </Text>
            <Text variant="bodySm" className="mt-3 max-w-2xl sm:text-base">
              Image for quick stills, video for scenes, motion for remixes, workflow
              for repeatable systems.
            </Text>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {CREATOR_TOOLS.map((tool) => (
              <Link
                key={tool.id}
                href={tool.href}
                prefetch={
                  tool.id === 'workflow' || tool.id === 'video' ? false : undefined
                }
                className="ui-pill ui-focus-ring hover:border-white/18 hover:bg-white/[0.06] hover:text-white"
              >
                {tool.shortLabel}
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
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
            eyebrow="Quick starts"
            title="Try a setup and move."
            actionHref="/showcase"
            actionLabel="Explore showcase"
            variant="minimal"
          />

          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
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
