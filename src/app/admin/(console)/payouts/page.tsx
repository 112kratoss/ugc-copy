import Link from 'next/link';

import { Surface, Text } from '@/app/components/DesignSystem';
import {
  listOpenCreatorPayoutRequests,
  listResolvedCreatorPayoutRequests,
} from '@/lib/creator-payout-ops';
import { formatTokenSubunitsAsUsd } from '@/lib/creator-payouts';
import { createServiceClient } from '@/lib/server-helpers';

import {
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  StatusBadge,
  Td,
  formatRelative,
  formatTimestamp,
  parseOffset,
  shortId,
} from '../AdminUi';
import { PayoutActions } from './PayoutActions';

export const dynamic = 'force-dynamic';

const HISTORY_PAGE_SIZE = 25;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text as="span" variant="caption" className="uppercase tracking-[0.08em]">{label}</Text>
      <div className="mt-0.5 text-sm text-[var(--ui-text-secondary)]">{children}</div>
    </div>
  );
}

export default async function AdminPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ history?: string }>;
}) {
  const { history: historyParam } = await searchParams;
  const historyOffset = parseOffset(historyParam, HISTORY_PAGE_SIZE);

  const client = createServiceClient();
  const [requests, history] = await Promise.all([
    listOpenCreatorPayoutRequests(client),
    listResolvedCreatorPayoutRequests(client, { limit: HISTORY_PAGE_SIZE, offset: historyOffset }),
  ]);
  const totalSubunits = requests.reduce((sum, request) => sum + request.amountTokenSubunits, 0);

  return (
    <>
      <PageHeader
        title="Creator payouts"
        description="Open withdrawal requests. The balance is already held against each request, so rejecting returns it to the creator and marking paid consumes it."
      />

      <section className="grid gap-3 sm:grid-cols-2">
        <StatCard label="Open requests" value={String(requests.length)} />
        <StatCard label="Total owed" value={formatTokenSubunitsAsUsd(totalSubunits)} />
      </section>

      <section className="mt-6 space-y-3">
        {requests.length === 0 ? (
          <EmptyState message="No open payouts. Requests appear here as soon as a creator withdraws." />
        ) : null}

        {requests.map((request) => (
          <Surface key={request.id} className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Text as="h3" variant="cardTitle">
                {request.amountUsd} to {request.displayName ?? request.username ?? shortId(request.userId)}
              </Text>
              <Text as="span" variant="caption">
                {formatRelative(request.requestedAt)} · {formatTimestamp(request.requestedAt)}
              </Text>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Method">{request.payoutMethod}</Field>
              <Field label="Destination">{request.payoutDetails}</Field>
              <Field label="Lifetime earned">
                {formatTokenSubunitsAsUsd(request.lifetimeEarnedTokenSubunits)}
              </Field>
            </div>

            <PayoutActions requestId={request.id} amountUsd={request.amountUsd} />
          </Surface>
        ))}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Settled payouts</Text>

        {history.requests.length === 0 ? (
          <EmptyState message="No payouts have been settled yet." />
        ) : (
          <DataTable columns={['Resolved', 'Outcome', 'Amount', 'Creator', 'Method', 'Reference', 'Note', 'Operator']}>
            {history.requests.map((request) => (
              <tr key={request.id}>
                <Td>{formatTimestamp(request.resolvedAt)}</Td>
                <Td>
                  <StatusBadge
                    status={request.status}
                    tone={request.status === 'paid' ? 'ok' : 'danger'}
                  />
                </Td>
                <Td>{request.amountUsd}</Td>
                <Td>
                  <Link href={`/admin/users/${request.userId}`} className="underline">
                    {request.displayName || (request.username ? `@${request.username}` : shortId(request.userId))}
                  </Link>
                </Td>
                <Td>{request.payoutMethod}</Td>
                <Td mono>{request.externalReference ?? '—'}</Td>
                <Td truncateWidth={260}>{request.resolutionNote ?? '—'}</Td>
                <Td mono>{shortId(request.resolvedBy)}</Td>
              </tr>
            ))}
          </DataTable>
        )}

        <Pagination
          basePath="/admin/payouts"
          offsetParam="history"
          offset={history.offset}
          pageSize={HISTORY_PAGE_SIZE}
          total={history.total}
          noun="settled payouts"
        />
      </section>
    </>
  );
}
