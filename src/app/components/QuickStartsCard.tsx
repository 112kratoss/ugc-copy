import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { getAccentClasses, Kicker } from '@/app/components/DesignSystem';
import { CREATOR_TOOLS } from '@/lib/creator-tools';

/**
 * Compact create entry points for the dashboard rail. Server-rendered, ships
 * no JS — the four tools are the same CREATOR_TOOLS the marketing page and
 * /create use, so a new tool appears here automatically.
 */
export default function QuickStartsCard() {
  return (
    <section aria-label="Quick starts" className="ui-card flex flex-col gap-3 p-5">
      <Kicker>Quick starts</Kicker>
      <ul className="flex flex-col gap-1">
        {CREATOR_TOOLS.map((tool) => {
          const Icon = tool.icon;
          const theme = getAccentClasses(tool.accent);

          return (
            <li key={tool.id}>
              <Link
                href={tool.href}
                prefetch={false}
                className="ui-focus-ring group flex min-h-12 items-center gap-3 rounded-2xl border border-transparent px-2.5 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:border-[var(--ui-border-subtle)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border transition ${theme.iconWrap}`}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                {tool.shortLabel}
                <ArrowRight
                  className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--ui-text-faint)] transition group-hover:translate-x-0.5 group-hover:text-[var(--ui-primary)]"
                  aria-hidden
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
