import Link from 'next/link';
import { SearchX } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';

/**
 * Rendered in place of the support record when a user id does not resolve.
 *
 * Deliberately NOT `notFound()`. A `not-found.tsx` boundary was tried at the
 * console group, at `/admin`, and at the app root, and in this app none of them
 * render — `notFound()` always falls through to Next's built-in error shell,
 * which drops the sidebar and leaves a support lookup at a dead end. Rendering
 * the state inline keeps the operator inside the console with their navigation.
 *
 * The trade-off is an HTTP 200 for a record that does not exist. That is
 * acceptable here and nowhere else: `/admin` is noindex, is never crawled or
 * cached, and the only consumer is an operator reading the page.
 */
export function UserNotFoundPanel({ userId }: { userId: string }) {
  return (
    <Surface variant="card" padding="md">
      <div className="flex items-start gap-3">
        <SearchX className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-text-faint)]" aria-hidden />
        <div className="min-w-0">
          <Text as="h1" variant="cardTitle">No user with that id</Text>
          <Text variant="bodySm" className="mt-1.5">
            Nothing in <code className="font-mono text-[12px]">profiles</code> matches{' '}
            <span className="font-mono text-[12px] break-all">{userId}</span>. An id copied from a
            log may belong to a deleted account — deletion cascades the profile but deliberately
            leaves purchases and payout records behind.
          </Text>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/admin/users" className="ui-button ui-button-primary ui-focus-ring">
              Search users
            </Link>
            <Link href="/admin/activity" className="ui-button ui-button-secondary ui-focus-ring">
              Operator activity
            </Link>
          </div>
        </div>
      </div>
    </Surface>
  );
}
