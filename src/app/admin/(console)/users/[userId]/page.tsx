import Link from 'next/link';
import { ArrowLeft, ExternalLink, ShieldBan } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';
import { listAdminCreditAdjustments } from '@/lib/admin-credit-adjustment-service';
import {
  getAdminUserAccountState,
  listAdminUserSanctions,
} from '@/lib/admin-user-sanction-service';
import { getAdminUserDetail } from '@/lib/admin-users-service';
import { createServiceClient } from '@/lib/server-helpers';

import {
  DataTable,
  EmptyState,
  PageHeader,
  StatCard,
  StatusBadge,
  Td,
  formatSubunits,
  formatTimestamp,
  shortId,
} from '../../AdminUi';
import { CreditAdjustmentForm } from './CreditAdjustmentForm';
import { UserNotFoundPanel } from './UserNotFoundPanel';
import { UserSanctionForm } from './UserSanctionForm';

export const dynamic = 'force-dynamic';

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text as="span" variant="caption" className="uppercase tracking-[0.08em]">{label}</Text>
      <div className="mt-0.5 break-words text-sm text-[var(--ui-text-secondary)]">{value}</div>
    </div>
  );
}

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const client = createServiceClient();

  const detail = await getAdminUserDetail(client, userId).catch(() => null);
  if (!detail) {
    return <UserNotFoundPanel userId={userId} />;
  }

  // These tables only exist after their admin migrations are applied, so a
  // missing relation degrades rather than taking the whole support record down.
  const [adjustments, sanctions, accountState] = await Promise.all([
    listAdminCreditAdjustments(client, userId).catch(() => []),
    listAdminUserSanctions(client, userId).catch(() => []),
    getAdminUserAccountState(client, userId).catch(() => ({ isSuspended: false, bannedUntil: null })),
  ]);

  return (
    <>
      <Link
        href="/admin/users"
        className="ui-focus-ring mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All users
      </Link>

      <PageHeader
        title={detail.profile.displayName || 'Unnamed user'}
        description={detail.profile.username ? `@${detail.profile.username}` : 'No username set'}
        actions={detail.profile.username ? (
          <Link
            href={`/creators/${detail.profile.username}`}
            target="_blank"
            rel="noreferrer"
            className="ui-button ui-button-secondary ui-focus-ring"
          >
            Public profile
            <ExternalLink className="h-4 w-4" aria-hidden />
          </Link>
        ) : undefined}
      />

      {accountState.isSuspended ? (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--ui-accent-danger)] bg-[rgba(255,124,139,0.08)] px-4 py-3"
        >
          <ShieldBan className="h-5 w-5 shrink-0 text-[var(--ui-accent-danger)]" aria-hidden />
          <Text as="span" variant="label" className="text-[var(--ui-accent-danger)]">
            Account suspended — this user cannot sign in.
          </Text>
          <Text as="span" variant="caption">
            Until {formatTimestamp(accountState.bannedUntil)}
          </Text>
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Credits" value={detail.profile.credits} />
        <StatCard label="Promo credits" value={detail.profile.promotionalCredits} />
        <StatCard label="Generations" value={detail.counts.generations} hint={`${detail.spend.generationsLast30Days} in 30 days`} />
        <StatCard
          label="Open reports"
          value={detail.counts.openReportsAgainst}
          tone={detail.counts.openReportsAgainst > 0 ? 'danger' : 'ok'}
        />
      </section>

      <section className="mt-6">
        <Surface variant="card" padding="md">
          <Text as="h2" variant="label" className="mb-3">Account</Text>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="User id" value={<span className="font-mono text-xs">{detail.profile.id}</span>} />
            <Detail label="Email" value={detail.email ?? '—'} />
            <Detail label="Joined" value={formatTimestamp(detail.profile.createdAt)} />
            <Detail label="Last sign in" value={formatTimestamp(detail.lastSignInAt)} />
            <Detail label="Email confirmed" value={formatTimestamp(detail.emailConfirmedAt)} />
            <Detail label="Posts" value={detail.counts.posts} />
            <Detail label="Followers" value={detail.counts.followers} />
            <Detail label="Following" value={detail.counts.following} />
            <Detail label="Lifetime credits spent" value={detail.spend.lifetimeCreditsSpent.toLocaleString()} />
            <Detail label="Location" value={detail.profile.location ?? '—'} />
            <Detail label="Website" value={detail.profile.websiteUrl ?? '—'} />
            <Detail
              label="Creator wallet"
              value={detail.wallet
                ? `${formatSubunits(detail.wallet.availableTokenSubunits)} available`
                : 'No wallet'}
            />
          </div>
        </Surface>
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Purchases</Text>
        {detail.purchases.length === 0 ? (
          <EmptyState message="No purchases on record." />
        ) : (
          <DataTable columns={['Date', 'Rail', 'Status', 'Amount', 'Credits', 'Reference']}>
            {detail.purchases.map((purchase) => (
              <tr key={`${purchase.kind}-${purchase.id}`}>
                <Td>{formatTimestamp(purchase.createdAt)}</Td>
                <Td>{purchase.kind === 'razorpay' ? 'Razorpay (web)' : 'Mobile IAP'}</Td>
                <Td><StatusBadge status={purchase.status} /></Td>
                <Td>{formatSubunits(purchase.amountSubunits, purchase.currency)}</Td>
                <Td>{purchase.credits?.toLocaleString() ?? '—'}</Td>
                <Td mono>{purchase.reference ?? '—'}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mt-8">
        <UserSanctionForm
          userId={detail.profile.id}
          isSuspended={accountState.isSuspended}
          bannedUntil={accountState.bannedUntil ? formatTimestamp(accountState.bannedUntil) : null}
        />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Account sanctions</Text>
        {sanctions.length === 0 ? (
          <EmptyState message="No suspensions or reinstatements on record." />
        ) : (
          <DataTable columns={['Date', 'Action', 'Until', 'Reason', 'Operator']}>
            {sanctions.map((sanction) => (
              <tr key={sanction.id}>
                <Td>{formatTimestamp(sanction.createdAt)}</Td>
                <Td>
                  <StatusBadge
                    status={sanction.action === 'suspend' ? 'suspended' : 'reinstated'}
                    tone={sanction.action === 'suspend' ? 'danger' : 'ok'}
                  />
                </Td>
                <Td>{sanction.action === 'suspend' ? formatTimestamp(sanction.suspendedUntil) : '—'}</Td>
                <Td truncateWidth={320}>{sanction.reason}</Td>
                <Td mono>{shortId(sanction.reviewerId)}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mt-8">
        <CreditAdjustmentForm
          userId={detail.profile.id}
          credits={detail.profile.credits}
          promotionalCredits={detail.profile.promotionalCredits}
        />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Credit grants & adjustments</Text>
        {detail.creditGrants.length === 0 && adjustments.length === 0 ? (
          <EmptyState message="No credit grants or operator adjustments on record." />
        ) : (
          <DataTable columns={['Date', 'Source', 'Credits', 'Promo credits', 'Reason / program']}>
            {adjustments.map((adjustment) => (
              <tr key={adjustment.id}>
                <Td>{formatTimestamp(adjustment.createdAt)}</Td>
                <Td><StatusBadge status="admin" tone="warning" /></Td>
                <Td>{adjustment.creditsDelta > 0 ? `+${adjustment.creditsDelta}` : adjustment.creditsDelta}</Td>
                <Td>
                  {adjustment.promotionalCreditsDelta > 0
                    ? `+${adjustment.promotionalCreditsDelta}`
                    : adjustment.promotionalCreditsDelta}
                </Td>
                <Td>{adjustment.reason}</Td>
              </tr>
            ))}
            {detail.creditGrants.map((grant) => (
              <tr key={grant.id}>
                <Td>{formatTimestamp(grant.claimedAt)}</Td>
                <Td>{grant.sourceSurface}</Td>
                <Td>{grant.amount > 0 ? `+${grant.amount}` : grant.amount}</Td>
                <Td>{grant.promotionalAmount > 0 ? `+${grant.promotionalAmount}` : grant.promotionalAmount}</Td>
                <Td mono>{grant.programKey}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Recent generations</Text>
        {detail.recentGenerations.length === 0 ? (
          <EmptyState message="No generations yet." />
        ) : (
          <DataTable columns={['Date', 'Status', 'Model', 'Cost', 'Error', 'Id']}>
            {detail.recentGenerations.map((generation) => (
              <tr key={generation.id}>
                <Td>{formatTimestamp(generation.createdAt)}</Td>
                <Td><StatusBadge status={generation.status} /></Td>
                <Td>{generation.model ?? '—'}</Td>
                <Td>{generation.cost?.toLocaleString() ?? '—'}</Td>
                <Td truncateWidth={280}>{generation.errorMessage ?? '—'}</Td>
                <Td mono>{shortId(generation.id)}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
