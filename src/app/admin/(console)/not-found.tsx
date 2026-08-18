import Link from 'next/link';
import { SearchX } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';

/**
 * Rendered inside the console group so `notFound()` — raised by the user detail
 * page for an id that does not resolve — keeps the operator in the console.
 * Without it the request fell through to the public 404, which drops the
 * sidebar entirely and leaves a support lookup at a dead end.
 */
export default function AdminConsoleNotFound() {
  return (
    <Surface variant="card" padding="md">
      <div className="flex items-start gap-3">
        <SearchX className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-text-faint)]" aria-hidden />
        <div>
          <Text as="h1" variant="cardTitle">Not found in the console</Text>
          <Text variant="bodySm" className="mt-1.5">
            That record does not exist. A user id copied from a log may belong to a deleted
            account — deletion cascades the profile but leaves purchases and payouts behind.
          </Text>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/admin/users" className="ui-button ui-button-primary ui-focus-ring">
              Search users
            </Link>
            <Link href="/admin" className="ui-button ui-button-secondary ui-focus-ring">
              Overview
            </Link>
          </div>
        </div>
      </div>
    </Surface>
  );
}
