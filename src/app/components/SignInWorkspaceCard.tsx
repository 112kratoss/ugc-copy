import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';

import { Button, Kicker, Text } from '@/app/components/DesignSystem';

/**
 * The signed-out counterpart to the dashboard's WorkspaceCard: it holds the
 * same rail slot so the page reads identically before and after sign-in, and
 * states plainly what signing in unlocks instead of showing an empty
 * workspace.
 */
export default function SignInWorkspaceCard() {
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
        <Button href="/login?returnUrl=/create" prefetch={false} variant="primary" icon={ArrowRight}>
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
