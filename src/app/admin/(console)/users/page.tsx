import Link from 'next/link';
import { Search } from 'lucide-react';

import { Text } from '@/app/components/DesignSystem';

import { getAdminUserAccountStates } from '@/lib/admin-user-sanction-service';
import { searchAdminUsers } from '@/lib/admin-users-service';
import { createServiceClient } from '@/lib/server-helpers';

import {
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  StatusBadge,
  Td,
  formatTimestamp,
  parseOffset,
  shortId,
} from '../AdminUi';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; offset?: string }>;
}) {
  const { q, offset: offsetParam } = await searchParams;
  const term = (q ?? '').trim();
  const offset = parseOffset(offsetParam, PAGE_SIZE);
  const client = createServiceClient();
  const { users, total, offset: effectiveOffset } = await searchAdminUsers(client, {
    term,
    limit: PAGE_SIZE,
    offset,
  });

  // Resolved for the rendered page only, in one round trip. A suspended account
  // looks identical to an active one in this table otherwise, so an operator
  // searching for a user they just actioned cannot tell it worked.
  const accountStates = await getAdminUserAccountStates(client, users.map((user) => user.id))
    .catch(() => new Map());

  return (
    <>
      <PageHeader
        title="Users & credits"
        description="Search by username, display name, or user id. Open a user for their full support record."
      />

      <form method="get" className="mb-6 flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ui-text-faint)]"
            aria-hidden
          />
          <input
            type="search"
            name="q"
            defaultValue={term}
            placeholder="Username, display name, or user id"
            aria-label="Search users"
            className="ui-focus-ring w-full rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] py-2.5 pl-9 pr-3 text-sm text-[var(--ui-text-primary)] placeholder:text-[var(--ui-text-faint)]"
          />
        </div>
        <button type="submit" className="ui-button ui-button-primary ui-focus-ring">Search</button>
        {term ? (
          <Link href="/admin/users" className="ui-button ui-button-ghost ui-focus-ring">Clear</Link>
        ) : null}
      </form>

      {users.length === 0 ? (
        <EmptyState message={term ? `No users match “${term}”.` : 'No users found.'} />
      ) : (
        <DataTable columns={['User', 'Username', 'Status', 'Credits', 'Promo credits', 'Joined', 'Id']}>
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-[var(--ui-surface-2)]">
              <Td>
                <Link href={`/admin/users/${user.id}`} className="font-semibold text-[var(--ui-text-primary)] underline">
                  {user.displayName || 'Unnamed'}
                </Link>
              </Td>
              <Td>{user.username ? `@${user.username}` : '—'}</Td>
              <Td>
                {accountStates.get(user.id)?.isSuspended
                  ? <StatusBadge status="suspended" tone="danger" />
                  : <Text as="span" variant="caption">Active</Text>}
              </Td>
              <Td>{user.credits.toLocaleString()}</Td>
              <Td>{user.promotionalCredits.toLocaleString()}</Td>
              <Td>{formatTimestamp(user.createdAt)}</Td>
              <Td mono>{shortId(user.id)}</Td>
            </tr>
          ))}
        </DataTable>
      )}

      <Pagination
        basePath="/admin/users"
        offset={effectiveOffset}
        pageSize={PAGE_SIZE}
        total={total}
        otherParams={term ? { q: term } : {}}
        noun="users"
      />
    </>
  );
}
