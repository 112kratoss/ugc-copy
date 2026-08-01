import { Surface, Text } from '@/app/components/DesignSystem';
import { listOpenCreatorPayoutRequests } from '@/lib/creator-payout-ops';
import { formatTokenSubunitsAsUsd } from '@/lib/creator-payouts';
import { createServiceClient } from '@/lib/server-helpers';

import { EmptyState, PageHeader, StatCard, formatRelative, formatTimestamp, shortId } from '../AdminUi';
import { PayoutActions } from './PayoutActions';

export const dynamic = 'force-dynamic';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text as="span" variant="caption" className="uppercase tracking-[0.08em]">{label}</Text>
      <div className="mt-0.5 text-sm text-[var(--ui-text-secondary)]">{children}</div>
    </div>
  );
}

export default async function AdminPayoutsPage() {
  const requests = await listOpenCreatorPayoutRequests(createServiceClient());
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
    </>
  );
}
