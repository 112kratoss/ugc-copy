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
