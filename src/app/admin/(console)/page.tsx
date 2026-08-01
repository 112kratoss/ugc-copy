import Link from 'next/link';
import {
  AlertTriangle,
  BadgeIndianRupee,
  FileImage,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';
import { collectAdminOverview } from '@/lib/admin-overview-service';
import { createServiceClient } from '@/lib/server-helpers';

import {
  DataTable,
  EmptyState,
  PageHeader,
  StatCard,
  StatusBadge,
  Td,
  formatTimestamp,
} from './AdminUi';

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  const overview = await collectAdminOverview(createServiceClient());
  const { counters, dashboard, dashboardError } = overview;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Platform counters and the live backend health, cost, and alert panels."
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Users" value={counters.totalUsers} hint={`+${counters.newUsers7d} in 7 days`} icon={Users} />
        <StatCard label="Posts" value={counters.totalPosts} hint={`+${counters.newPosts7d} in 7 days`} icon={FileImage} />
        <StatCard
          label="Generations 24h"
          value={counters.generations24h}
          hint={`${counters.failedGenerations24h} failed`}
          icon={Sparkles}
          tone={counters.failedGenerations24h > 0 ? 'warning' : 'neutral'}
        />
        <StatCard
          label="Open reports"
          value={counters.openModerationReports}
          hint="4h review SLO"
          icon={ShieldAlert}
          tone={counters.openModerationReports > 0 ? 'danger' : 'ok'}
        />
      </section>

      <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Paid orders 30d"
          value={counters.paidOrders30d}
          hint="Razorpay credit purchases"
          icon={BadgeIndianRupee}
        />
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Text as="h2" variant="cardTitle">Backend status</Text>
          {dashboard ? <StatusBadge status={dashboard.status} /> : null}
        </div>

        {dashboardError ? (
          <Surface variant="card" padding="md" className="border-[var(--ui-accent-danger)]">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ui-accent-danger)]" aria-hidden />
              <div>
                <Text as="p" variant="label">Could not collect the backend dashboard</Text>
                <Text variant="bodySm" className="mt-1 font-mono text-[12px]">{dashboardError}</Text>
              </div>
            </div>
          </Surface>
        ) : null}

        {dashboard ? (
          <>
            <div className="grid gap-3 lg:grid-cols-3">
              {dashboard.panels.map((panel) => (
                <Surface key={panel.id} variant="card" padding="md">
                  <div className="flex items-center justify-between gap-3">
                    <Text as="h3" variant="label">{panel.title}</Text>
                    <StatusBadge status={panel.status} />
                  </div>
                  <Text variant="bodySm" className="mt-2">{panel.summary}</Text>
                  {panel.issueCount > 0 ? (
                    <Text variant="caption" className="mt-2 text-[var(--ui-accent-danger)]">
                      {panel.issueCount} issue{panel.issueCount === 1 ? '' : 's'}
                    </Text>
                  ) : null}

                  <dl className="mt-4 flex flex-col gap-1.5">
                    {Object.entries(panel.metrics).slice(0, 6).map(([key, value]) => (
                      <div key={key} className="flex items-baseline justify-between gap-3">
                        <dt>
                          <Text as="span" variant="caption">{key}</Text>
                        </dt>
                        <dd className="font-mono text-[12px] text-[var(--ui-text-secondary)]">
                          {value === null ? '—' : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Surface>
              ))}
            </div>

            <Text variant="caption" className="mt-3">
              Checked {formatTimestamp(dashboard.checkedAt)} · build {dashboard.buildId}
            </Text>
          </>
        ) : null}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Alert delivery</Text>
        {dashboard?.alertDelivery ? (
          <DataTable columns={['Field', 'Value']}>
            {Object.entries(dashboard.alertDelivery as Record<string, unknown>).map(([key, value]) => (
              <tr key={key}>
                <Td>{key}</Td>
                <Td mono>{value === null || value === undefined ? '—' : String(value)}</Td>
              </tr>
            ))}
          </DataTable>
        ) : (
          <EmptyState message="Alert delivery status is unavailable." />
        )}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Jump to</Text>
        <div className="flex flex-wrap gap-2">
          {[
            { href: '/admin/moderation', label: 'Moderation queue' },
            { href: '/admin/users', label: 'Users & credits' },
            { href: '/admin/revenue', label: 'Revenue' },
            { href: '/admin/payouts', label: 'Creator payouts' },
            { href: '/admin/content', label: 'Content' },
            { href: '/admin/system', label: 'System' },
          ].map((link) => (
            <Link key={link.href} href={link.href} className="ui-button ui-button-secondary ui-focus-ring">
              {link.label}
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
