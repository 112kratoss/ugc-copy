import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { CreatorToolPreview } from '@/app/components/CreatorToolPreview';
import { CreatorToolCard, SectionHeading } from '@/app/components/CreatorStudio';
import {
  CREATOR_STARTER_RECIPES,
  CREATOR_TOOLS,
  getCreatorTool,
} from '@/lib/creator-tools';
import { loadCreatorToolPreviewMap } from '@/lib/creator-tool-previews';

const RECIPE_ACCENTS = {
  image: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
  video: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
  motion: 'border-violet-400/20 bg-violet-400/10 text-violet-100',
  workflow: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
} as const;

export default async function CreateHubPage() {
  const previewByTool = await loadCreatorToolPreviewMap();

  return (
    <div className="relative min-h-screen overflow-hidden bg-black pb-20 text-white font-[family-name:var(--font-geist-sans)]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[10%] top-20 h-52 w-52 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="absolute right-[10%] top-20 h-64 w-64 rounded-full bg-fuchsia-500/10 blur-3xl" />
      </div>

      <div className="studio-shell relative z-10 pt-10 sm:pt-14">
        <section>
          <div className="max-w-3xl">
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-zinc-500">
              Creator launchpad
            </div>
            <h1 className="mt-4 max-w-[14ch] text-4xl font-semibold tracking-tight sm:text-5xl lg:text-[3.75rem]">
              Pick the path that gets you to a first output fastest.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400 sm:text-base">
              Image for quick stills, video for scenes, motion for remixes, workflow
              for repeatable systems.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {CREATOR_TOOLS.map((tool) => (
              <Link
                key={tool.id}
                href={tool.href}
                prefetch={
                  tool.id === 'workflow' || tool.id === 'video' ? false : undefined
                }
                className="rounded-full border border-white/8 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
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
                  className="group rounded-[24px] border border-white/8 bg-[#111215] p-4 transition hover:border-white/12 hover:bg-white/[0.04]"
                >
                  <div
                    className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${RECIPE_ACCENTS[recipe.toolId]}`}
                  >
                    {tool.shortLabel}
                  </div>
                  <h3 className="mt-4 text-[1.2rem] font-semibold tracking-tight text-white">
                    {recipe.title}
                  </h3>
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-400">
                    {recipe.description}
                  </p>
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
