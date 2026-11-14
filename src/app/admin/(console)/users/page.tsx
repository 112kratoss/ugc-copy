import { requireAdminIdentity } from '@/lib/admin-auth';
import Link from 'next/link';
import clsx from 'clsx';
import { Search } from 'lucide-react';

import { Text } from '@/components/DesignSystem';

import { getAdminUserAccountStates } from '@/lib/admin-user-sanction-service';
import { ADMIN_USER_KINDS, searchAdminUsers, type AdminUserKind } from '@/lib/admin-users-service';
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

const KIND_LABELS: Record<AdminUserKind, string> = {
  registered: 'Accounts',
  guests: 'Guests',
  all: 'All',
};

const KIND_NOUNS: Record<AdminUserKind, string> = {
  registered: 'accounts',
  guests: 'guests',
  all: 'users',
};

function parseKind(value: string | undefined): AdminUserKind | undefined {
  return ADMIN_USER_KINDS.includes(value as AdminUserKind) ? (value as AdminUserKind) : undefined;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; offset?: string; kind?: string }>;
}) {
  await requireAdminIdentity();
  const { q, offset: offsetParam, kind: kindParam } = await searchParams;
  const term = (q ?? '').trim();
  const offset = parseOffset(offsetParam, PAGE_SIZE);
  // Left out, the service picks: accounts for the bare list, every kind for a search.
  const requestedKind = parseKind(kindParam);
  const client = createServiceClient();
  const { users, total, offset: effectiveOffset, kind } = await searchAdminUsers(client, {
    term,
    kind: requestedKind,
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

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {ADMIN_USER_KINDS.map((option) => {
          const query = new URLSearchParams({ ...(term ? { q: term } : {}), kind: option });
          return (
            <Link
              key={option}
              href={`/admin/users?${query.toString()}`}
              aria-current={option === kind ? 'page' : undefined}
              className={clsx(
                'ui-button ui-focus-ring',
                option === kind ? 'ui-button-primary' : 'ui-button-secondary',
              )}
            >
              {KIND_LABELS[option]}
            </Link>
          );
        })}
      </div>
      <Text variant="caption" className="mb-4 block">
        Guests are the sessions the app opens before someone signs up, one per install,
        reinstall or sign-out. A linked guest is the one a device had before its owner
        signed in, and is now part of that account.
      </Text>

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
        {requestedKind ? <input type="hidden" name="kind" value={requestedKind} /> : null}
        <button type="submit" className="ui-button ui-button-primary ui-focus-ring">Search</button>
        {term ? (
          <Link
            href={requestedKind ? `/admin/users?kind=${requestedKind}` : '/admin/users'}
            className="ui-button ui-button-ghost ui-focus-ring"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {users.length === 0 ? (
        <EmptyState message={term ? `No ${KIND_NOUNS[kind]} match “${term}”.` : `No ${KIND_NOUNS[kind]} found.`} />
      ) : (
        <DataTable columns={['User', 'Username', 'Type', 'Status', 'Credits', 'Promo credits', 'Joined', 'Id']}>
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-[var(--ui-surface-2)]">
              <Td>
                <Link href={`/admin/users/${user.id}`} className="font-semibold text-[var(--ui-text-primary)] underline">
                  {user.displayName || (user.isGuest ? 'Guest' : 'No name set')}
                </Link>
              </Td>
              <Td>{user.username ? `@${user.username}` : '—'}</Td>
              <Td>
                {!user.isGuest ? (
                  <Text as="span" variant="caption">Account</Text>
                ) : user.linkedToUserId ? (
                  <Link href={`/admin/users/${user.linkedToUserId}`} className="text-xs underline">
                    Linked guest
                  </Link>
                ) : (
                  <Text as="span" variant="caption">Guest</Text>
                )}
              </Td>
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
        otherParams={{
          ...(term ? { q: term } : {}),
          ...(requestedKind ? { kind: requestedKind } : {}),
        }}
        noun={KIND_NOUNS[kind]}
      />
    </>
  );
}
