import { requireAdminIdentity } from '@/lib/admin-auth';
import Link from 'next/link';
import clsx from 'clsx';

import { Text } from '@/components/DesignSystem';
import {
  ADMIN_REFERRALS_PAGE_SIZE,
  getAdminReferralOverview,
  parseAdminReferralFilter,
  type AdminReferralFilter,
  type AdminReferralParty,
  type AdminReferralRow,
} from '@/lib/admin-referrals-service';
import { createServiceClient } from '@/lib/server-helpers';

import {
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  StatCard,
  StatusBadge,
  Td,
  formatTimestamp,
  parseOffset,
  shortId,
} from '../AdminUi';
import { ReferralReviewActions } from './ReferralReviewActions';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ value: AdminReferralFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'flagged', label: 'Flagged' },
  { value: 'blocked', label: 'Blocked' },
];

/** What the abuse guard wrote, in an operator's words. Anything else is an operator's own reason. */
const GUARD_REASONS: Record<string, string> = {
  same_device_as_inviter: 'Signed up on the inviter’s own device',
  device_reused_by_invitees: 'Signed up on a device another friend of this inviter used',
};

const RISK_FLAGS: Record<string, string> = {
  shared_device: 'Device also used by another account',
  same_network: 'Same network as the inviter',
};

function filterHref(filter: AdminReferralFilter) {
  return filter === 'all' ? '/admin/referrals' : `/admin/referrals?state=${filter}`;
}

function PartyCell({ party }: { party: AdminReferralParty }) {
  if (!party.userId) {
    return (
      <span>
        Deleted account
        {party.detachedUserId ? (
          <span className="block break-all text-xs">{party.detachedUserId}</span>
        ) : null}
      </span>
    );
  }

  return (
    <Link href={`/admin/users/${party.userId}`} className="underline">
      {party.displayName || (party.username ? `@${party.username}` : shortId(party.userId))}
    </Link>
  );
}

function RewardStateCell({ referral }: { referral: AdminReferralRow }) {
  const reason = referral.rewardStateReason
    ? GUARD_REASONS[referral.rewardStateReason] ?? referral.rewardStateReason
    : null;

  return (
    <div className="space-y-1">
      <StatusBadge
        status={referral.rewardState === 'blocked' ? 'blocked' : 'pays'}
        tone={referral.rewardState === 'blocked' ? 'danger' : 'ok'}
      />
      {reason ? <Text as="p" variant="caption">{reason}</Text> : null}
      {referral.rewardStateChangedAt ? (
        <Text as="p" variant="caption">
          {referral.rewardStateSource === 'operator' ? 'Operator' : 'Guard'} · {formatTimestamp(referral.rewardStateChangedAt)}
        </Text>
      ) : null}
    </div>
  );
}

export default async function AdminReferralsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; offset?: string }>;
}) {
  await requireAdminIdentity();
  const { state: stateParam, offset: offsetParam } = await searchParams;
  const filter = parseAdminReferralFilter(stateParam);

  const overview = await getAdminReferralOverview(createServiceClient(), {
    filter,
    offset: parseOffset(offsetParam, ADMIN_REFERRALS_PAGE_SIZE),
  });

  return (
    <>
      <PageHeader
        title="Referrals"
        description="Invite & Earn: who invited whom, and whether a friend’s top-ups pay. A blocked referral pays nothing; unblock it and the top-ups it skipped settle within the hour. Credits already paid are taken back with a credit adjustment on the account."
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Invite links"
          value={overview.stats.inviteLinks}
          hint={overview.stats.disabledLinks > 0 ? `${overview.stats.disabledLinks} switched off` : undefined}
        />
        <StatCard label="Referrals" value={overview.stats.referrals} />
        <StatCard label="Flagged" value={overview.stats.flagged} hint="A hint, not a block" />
        <StatCard
          label="Blocked"
          value={overview.stats.blocked}
          tone={overview.stats.blocked > 0 ? 'danger' : 'neutral'}
        />
      </section>

      <nav aria-label="Referral filter" className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((entry) => (
          <Link
            key={entry.value}
            href={filterHref(entry.value)}
            aria-current={entry.value === filter ? 'page' : undefined}
            className={clsx(
              'ui-button ui-focus-ring',
              entry.value === filter ? 'ui-button-primary' : 'ui-button-secondary',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      <section className="mt-4">
        {overview.referrals.length === 0 ? (
          <EmptyState
            message={filter === 'all'
              ? 'No referrals yet. One appears here when a friend signs up through an invite.'
              : `No ${filter} referrals.`}
          />
        ) : (
          <DataTable columns={['Joined', 'Inviter', 'Friend', 'Rewards', 'Signals', 'Top-ups', 'Credits paid', 'Decision']}>
            {overview.referrals.map((referral) => (
              <tr key={referral.id}>
                <Td>{formatTimestamp(referral.attributedAt)}</Td>
                <Td>
                  <PartyCell party={referral.inviter} />
                  {referral.inviterCode && !referral.inviterCode.enabled ? (
                    <Text as="p" variant="caption">Link switched off</Text>
                  ) : null}
                </Td>
                <Td><PartyCell party={referral.invitee} /></Td>
                <Td><RewardStateCell referral={referral} /></Td>
                <Td>
                  {referral.riskFlags.length === 0
                    ? '—'
                    : referral.riskFlags.map((flag) => (
                        <span key={flag} className="block">{RISK_FLAGS[flag] ?? flag}</span>
                      ))}
                </Td>
                <Td>{referral.settledPurchases.toLocaleString()}</Td>
                <Td>{referral.activeRewardCredits.toLocaleString()}</Td>
                <Td>
                  <ReferralReviewActions
                    attributionId={referral.id}
                    rewardState={referral.rewardState}
                    inviterCode={referral.inviterCode
                      ? { id: referral.inviterCode.id, enabled: referral.inviterCode.enabled }
                      : null}
                  />
                </Td>
              </tr>
            ))}
          </DataTable>
        )}

        {overview.detailTruncated ? (
          <Text variant="caption" className="mt-2 block">
            This page’s top-ups and credits were read up to a limit, so its totals are a floor.
          </Text>
        ) : null}

        <Pagination
          basePath="/admin/referrals"
          offset={overview.offset}
          pageSize={overview.pageSize}
          total={overview.total}
          otherParams={filter === 'all' ? {} : { state: filter }}
          noun="referrals"
        />
      </section>
    </>
  );
}
