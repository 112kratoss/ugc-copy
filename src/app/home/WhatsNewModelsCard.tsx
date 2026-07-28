import Link from 'next/link';
import { Image as ImageIcon, Play, Rocket } from 'lucide-react';

import { getAccentClasses, Kicker, Pill, Text } from '@/app/components/DesignSystem';
import type { HomeWhatsNewModel } from '@/lib/home-dashboard';

// Same kind → glyph mapping the marketing page's model list uses.
const KIND_ICONS = {
  image: ImageIcon,
  video: Play,
  motion: Rocket,
} as const;

/**
 * Dynamic replacement for the marketing page's hardcoded LATEST_MODELS on the
 * signed-in surface: the list comes from the published catalog (`New` badges,
 * falling back to catalog order), so a model release shows up here without a
 * code change. Renders nothing when the catalog is unavailable.
 */
export default function WhatsNewModelsCard({ models }: { models: HomeWhatsNewModel[] }) {
  if (models.length === 0) {
    return null;
  }

  return (
    <section aria-label="What's new in models" className="ui-card flex flex-col gap-3 p-5">
      <Kicker>What&apos;s new</Kicker>
      <ul className="flex flex-col gap-1">
        {models.map((model) => {
          const Icon = KIND_ICONS[model.kind];
          const theme = getAccentClasses(model.accent);

          return (
            <li key={model.id}>
              <Link
                href={model.href}
                prefetch={false}
                className="ui-focus-ring group flex min-h-14 items-center gap-3 rounded-2xl border border-transparent px-2.5 py-2 transition hover:border-[var(--ui-border-subtle)] hover:bg-[var(--ui-surface-2)]"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition ${theme.iconWrap}`}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <Text as="span" variant="cardTitle" className="truncate text-sm">
                      {model.displayName}
                    </Text>
                    {model.badge ? <Pill accent={model.accent}>{model.badge}</Pill> : null}
                  </span>
                  <Text as="span" variant="caption" className="mt-0.5 line-clamp-1 text-[var(--ui-text-muted)]">
                    {model.description}
                  </Text>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
