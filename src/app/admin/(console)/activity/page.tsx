import { Fragment } from 'react';
import Link from 'next/link';

import { Text } from '@/app/components/DesignSystem';
import { collectAdminActivity, type AdminActivityKind } from '@/lib/admin-activity-service';
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
  type AdminStatusTone,
} from '../AdminUi';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/** Money and account access read as the highest-consequence actions. */
const KIND_LABELS: Record<AdminActivityKind, { label: string; tone: AdminStatusTone }> = {
  'credit-adjustment': { label: 'credits', tone: 'warning' },
  'user-sanction': { label: 'account', tone: 'danger' },
  'post-moderation': { label: 'post', tone: 'neutral' },
  'subject-moderation': { label: 'report', tone: 'neutral' },
  'generation-moderation': { label: 'generation', tone: 'neutral' },
  'contact-triage': { label: 'contact', tone: 'ok' },
  payout: { label: 'payout', tone: 'warning' },
};

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  const { offset: offsetParam } = await searchParams;
  const feed = await collectAdminActivity(createServiceClient(), {
    offset: parseOffset(offsetParam, PAGE_SIZE),
    pageSize: PAGE_SIZE,
  });

  return (
    <>
      <PageHeader
        title="Operator activity"
        description="Every action taken from this console, newest first — credits, account sanctions, moderation decisions and payouts in one place."
      />

      {feed.entries.length === 0 ? (
        <EmptyState message="No operator actions recorded yet." />
      ) : (
        <DataTable columns={['When', 'Type', 'Action', 'Subject', 'Detail', 'Operator']}>
          {feed.entries.map((entry) => {
            const kind = KIND_LABELS[entry.kind];
            return (
              <Fragment key={entry.id}>
                <tr>
                  <Td className="border-b-0">{formatTimestamp(entry.at)}</Td>
                  <Td className="border-b-0">
                    <StatusBadge status={kind.label} tone={kind.tone} />
                  </Td>
                  <Td className="border-b-0">{entry.action}</Td>
                  <Td className="border-b-0">
                    {entry.subjectUserId ? (
                      <Link href={`/admin/users/${entry.subjectUserId}`} className="font-mono text-xs underline">
                        {shortId(entry.subjectUserId)}
                      </Link>
                    ) : '—'}
                  </Td>
                  <Td className="border-b-0">
                    {entry.summary}
                    {entry.summaryUntil ? ` ${formatTimestamp(entry.summaryUntil)}` : null}
                  </Td>
                  <Td className="border-b-0" mono>{shortId(entry.reviewerId)}</Td>
                </tr>
                {/* Full width, for the same reason the moderation history gives
                    the rationale its own row: it is the field that answers the
                    question this page exists for. */}
                <tr>
                  <td
                    colSpan={6}
                    className="border-b border-[var(--ui-border-subtle)] px-4 pb-3 text-sm text-[var(--ui-text-secondary)]"
                  >
                    <span className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--ui-text-faint)]">
                      Rationale
                    </span>{' '}
                    {entry.rationale ?? (
                      <span className="italic text-[var(--ui-text-faint)]">No note recorded</span>
                    )}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </DataTable>
      )}

      <Pagination
        basePath="/admin/activity"
        offset={feed.offset}
        pageSize={feed.pageSize}
        total={feed.total}
        noun="operator actions"
      />

      {feed.truncated ? (
        <Text variant="caption" className="mt-2 block text-[var(--ui-accent-danger)]">
          One action type hit its per-source fetch cap, so older entries of that type are missing
          from this feed. Use the per-area history views for a complete record.
        </Text>
      ) : null}
    </>
  );
}
