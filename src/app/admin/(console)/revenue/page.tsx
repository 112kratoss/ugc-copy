import Link from 'next/link';
import clsx from 'clsx';

import { Surface, Text } from '@/app/components/DesignSystem';
import { collectAdminRevenueReport, type AdminRevenueWindow } from '@/lib/admin-revenue-service';
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
} from '../AdminUi';

export const dynamic = 'force-dynamic';

const WINDOWS: AdminRevenueWindow[] = [7, 30, 90];

function parseWindow(value: string | undefined): AdminRevenueWindow {
  const parsed = Number(value);
  return WINDOWS.includes(parsed as AdminRevenueWindow) ? (parsed as AdminRevenueWindow) : 30;
}

export default async function AdminRevenuePage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const { window } = await searchParams;
  const windowDays = parseWindow(window);
  const report = await collectAdminRevenueReport(createServiceClient(), { windowDays });

  const totalSucceeded = report.rails.reduce((total, rail) => total + rail.succeededCount, 0);
  const totalPending = report.rails.reduce((total, rail) => total + rail.pendingCount, 0);
  const totalFailed = report.rails.reduce((total, rail) => total + rail.failedCount, 0);

  return (
    <>
      <PageHeader
        title="Revenue"
        description="Four independent payment rails, reported separately. Currencies and settlement semantics differ, so totals are not blended."
        actions={
          <div className="flex gap-1.5">
            {WINDOWS.map((option) => (
              <Link
                key={option}
                href={`/admin/revenue?window=${option}`}
                className={clsx(
                  'ui-button ui-focus-ring',
                  option === windowDays ? 'ui-button-primary' : 'ui-button-secondary',
                )}
              >
                {option}d
              </Link>
            ))}
          </div>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Settled orders" value={totalSucceeded} hint={`Last ${windowDays} days`} />
        <StatCard label="Pending" value={totalPending} tone={totalPending > 0 ? 'warning' : 'neutral'} />
        <StatCard label="Failed / refunded" value={totalFailed} tone={totalFailed > 0 ? 'danger' : 'neutral'} />
        <StatCard
          label="Creator wallets"
          value={report.creatorPayouts.walletCount}
          hint={`${formatSubunits(report.creatorPayouts.availableTokenSubunits)} owed`}
        />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">By rail</Text>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {report.rails.map((rail) => (
            <Surface key={rail.key} variant="card" padding="md">
              <Text as="h3" variant="label">{rail.label}</Text>

              {/*
                One figure per currency. Summing across currencies would add
                rupees to dollars — post resource bundles already carry both.
              */}
              {rail.totalsByCurrency.length === 0 ? (
                <p className="mt-2 text-2xl font-extrabold leading-8 text-[var(--ui-text-primary)]">—</p>
              ) : (
                <div className="mt-2 flex flex-col gap-0.5">
                  {rail.totalsByCurrency.map((total) => (
                    <p
                      key={total.currency}
                      className="text-2xl font-extrabold leading-8 text-[var(--ui-text-primary)]"
                    >
                      {formatSubunits(total.grossSubunits, total.currency)}
                    </p>
                  ))}
                </div>
              )}
              <Text variant="caption" className="mt-1">
                {rail.totalsByCurrency.length > 1 ? 'Settled gross, per currency' : 'Settled gross'}
              </Text>

              <dl className="mt-3 flex flex-col gap-1">
                <div className="flex justify-between gap-2">
                  <dt><Text as="span" variant="caption">Settled</Text></dt>
                  <dd className="text-xs font-semibold text-[var(--ui-text-secondary)]">{rail.succeededCount}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt><Text as="span" variant="caption">Pending</Text></dt>
                  <dd className="text-xs font-semibold text-[var(--ui-text-secondary)]">{rail.pendingCount}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt><Text as="span" variant="caption">Failed</Text></dt>
                  <dd className="text-xs font-semibold text-[var(--ui-text-secondary)]">{rail.failedCount}</dd>
                </div>
                {rail.creditsIssued !== null ? (
                  <div className="flex justify-between gap-2">
                    <dt><Text as="span" variant="caption">Credits issued</Text></dt>
                    <dd className="text-xs font-semibold text-[var(--ui-text-secondary)]">
                      {rail.creditsIssued.toLocaleString()}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </Surface>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Recent orders</Text>
        {report.recentOrders.length === 0 ? (
          <EmptyState message={`No orders in the last ${windowDays} days.`} />
        ) : (
          <DataTable columns={['Date', 'Rail', 'Status', 'Amount', 'User', 'Reference']}>
            {report.recentOrders.map((order) => (
              <tr key={`${order.rail}-${order.id}`}>
                <Td>{formatTimestamp(order.createdAt)}</Td>
                <Td>{order.rail}</Td>
                <Td><StatusBadge status={order.status} /></Td>
                <Td>{formatSubunits(order.amountSubunits, order.currency)}</Td>
                <Td>
                  {order.userId ? (
                    <Link href={`/admin/users/${order.userId}`} className="font-mono text-xs underline">
                      {shortId(order.userId)}
                    </Link>
                  ) : '—'}
                </Td>
                <Td mono>{order.reference ?? '—'}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>
    </>
  );
}
