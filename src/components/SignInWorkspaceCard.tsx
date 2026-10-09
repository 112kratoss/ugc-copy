import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';

import { Button, Kicker, Text } from '@/components/DesignSystem';

/**
 * The signed-out counterpart to the dashboard's WorkspaceCard: it holds the
 * same rail slot so the page reads identically before and after sign-in, and
 * states plainly what signing in unlocks instead of showing an empty
 * workspace. `inline` is the one-line strip for widths without a rail, which
 * had no sign-in prompt at all below 1280px.
 */
export default function SignInWorkspaceCard({ variant = 'rail' }: { variant?: 'rail' | 'inline' }) {
  if (variant === 'inline') {
    return (
      <section aria-label="Workspace overview" className="ui-card mb-5 flex flex-wrap items-center gap-3 p-4">
        <Text variant="bodySm" className="min-w-0 flex-1 text-[var(--ui-text-muted)]">
          Sign in to track renders, keep creations in one Studio, and save recipes.
        </Text>
        <Button href="/login?returnUrl=%2F" prefetch={false} variant="primary" icon={ArrowRight}>
          Sign in
        </Button>
      </section>
    );
  }

  return (
    <section aria-label="Workspace overview" className="ui-card flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <Kicker>Workspace</Kicker>
        <span className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-3 text-xs font-bold text-[var(--ui-text-secondary)]">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Credits
        </span>
      </div>

      <Text variant="bodySm" className="text-[var(--ui-text-muted)]">
        Sign in to track renders as they finish, keep your creations in one Studio, and save
        recipes from the feed.
      </Text>

      <div className="flex items-center gap-2 border-t border-[var(--ui-border-subtle)] pt-4">
        <Button href="/login?returnUrl=%2F" prefetch={false} variant="primary" icon={ArrowRight}>
          Sign in
        </Button>
        <Link
          href="/pricing"
          prefetch={false}
          className="ui-focus-ring inline-flex min-h-9 items-center rounded-full px-3 text-xs font-bold text-[var(--ui-text-muted)] transition hover:text-[var(--ui-text-primary)]"
        >
          See plans
        </Link>
      </div>
    </section>
  );
}
