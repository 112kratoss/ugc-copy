import { Fragment } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { Text } from '@/app/components/DesignSystem';
import {
  ADMIN_MODERATION_HISTORY_PAGE_SIZE,
  collectAdminModerationHistory,
  type AdminModerationHistory,
} from '@/lib/admin-moderation-service';
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
} from '../../AdminUi';

export const dynamic = 'force-dynamic';

/**
 * The reviewer id is the durable record, but a bare UUID tells an operator
 * nothing, so the name leads and the id stays available underneath it.
 */
function ReviewerCell({
  reviewerId,
  reviewers,
}: {
  reviewerId: string | null;
  reviewers: AdminModerationHistory['reviewers'];
}) {
  if (!reviewerId) return <>—</>;

  const reviewer = reviewers[reviewerId];
  const name = reviewer?.displayName || (reviewer?.username ? `@${reviewer.username}` : null);

  return (
    <div>
      {name ? <div className="font-semibold text-[var(--ui-text-secondary)]">{name}</div> : null}
      <span className="font-mono text-[11px] text-[var(--ui-text-faint)]">{shortId(reviewerId)}</span>
    </div>
  );
}

/**
 * The rationale spans the full table width on its own row.
 *
 * As a trailing column it was the first thing clipped by the table's horizontal
 * scroll — which put the one field this page exists to show off the right-hand
 * edge. A decision with no rationale predates the mandatory-note rule, and
 * saying so is more useful than an em dash that reads like a rendering bug.
 */
function RationaleRow({ columnCount, note }: { columnCount: number; note: string | null }) {
  return (
    <tr>
      <td
        colSpan={columnCount}
        className="border-b border-[var(--ui-border-subtle)] px-4 pb-3 text-sm text-[var(--ui-text-secondary)]"
      >
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--ui-text-faint)]">
          Rationale
        </span>{' '}
        {note ?? <span className="italic text-[var(--ui-text-faint)]">No note recorded</span>}
      </td>
    </tr>
  );
}

export default async function AdminModerationHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ posts?: string; subjects?: string }>;
}) {
  const { posts, subjects } = await searchParams;
  const postOffset = parseOffset(posts, ADMIN_MODERATION_HISTORY_PAGE_SIZE);
  const subjectOffset = parseOffset(subjects, ADMIN_MODERATION_HISTORY_PAGE_SIZE);

  const history = await collectAdminModerationHistory(createServiceClient(), {
    postOffset,
    subjectOffset,
  });

  return (
    <>
      <Link
        href="/admin/moderation"
        className="ui-focus-ring mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Open queue
      </Link>

      <PageHeader
        title="Moderation history"
        description="Every resolved report with the operator who decided it and the rationale they recorded. This is the record an appeal is answered from."
      />

      <section>
        <Text as="h2" variant="cardTitle" className="mb-3">
          Post report decisions
        </Text>

        {history.postReports.length === 0 ? (
          <EmptyState message="No resolved post reports on this page." />
        ) : (
          <DataTable columns={['Decided', 'Action', 'Reason', 'Post', 'Reviewer']}>
            {history.postReports.map((report) => (
              <Fragment key={report.id}>
                <tr>
                  <Td className="border-b-0">{formatTimestamp(report.reviewedAt)}</Td>
                  <Td className="border-b-0">
                    <StatusBadge
                      status={report.resolutionAction ?? report.status}
                      tone={report.resolutionAction === 'take_down' ? 'danger' : 'ok'}
                    />
                  </Td>
                  <Td className="border-b-0"><StatusBadge status={report.reason} tone="warning" /></Td>
                  <Td className="border-b-0" truncateWidth={220}>
                    <Link href={`/post/${report.postId}`} target="_blank" rel="noreferrer" className="underline">
                      {report.post?.title || 'Untitled post'}
                    </Link>
                  </Td>
                  <Td className="border-b-0">
                    <ReviewerCell reviewerId={report.reviewedBy} reviewers={history.reviewers} />
                  </Td>
                </tr>
                <RationaleRow columnCount={5} note={report.resolutionNote} />
              </Fragment>
            ))}
          </DataTable>
        )}

        <Pagination
          basePath="/admin/moderation/history"
          offsetParam="posts"
          offset={history.postOffset}
          pageSize={history.pageSize}
          total={history.totals.postReports}
          otherParams={history.subjectOffset > 0 ? { subjects: String(history.subjectOffset) } : {}}
          noun="post decisions"
        />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">
          User, generation &amp; comment decisions
        </Text>

        {history.subjectReports.length === 0 ? (
          <EmptyState message="No resolved subject reports on this page." />
        ) : (
          <DataTable columns={['Decided', 'Outcome', 'Target', 'Reason', 'Subject', 'Reviewer']}>
            {history.subjectReports.map((report) => (
              <Fragment key={report.id}>
                <tr>
                  <Td className="border-b-0">{formatTimestamp(report.reviewedAt)}</Td>
                  <Td className="border-b-0">
                    <StatusBadge
                      status={report.status}
                      tone={report.status === 'resolved' ? 'danger' : 'ok'}
                    />
                  </Td>
                  <Td className="border-b-0"><StatusBadge status={report.targetType} tone="neutral" /></Td>
                  <Td className="border-b-0"><StatusBadge status={report.reason} tone="warning" /></Td>
                  <Td className="border-b-0">
                    {report.reportedUserId ? (
                      <Link href={`/admin/users/${report.reportedUserId}`} className="font-mono text-xs underline">
                        {shortId(report.reportedUserId)}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">
                        {shortId(report.generationId ?? report.commentId)}
                      </span>
                    )}
                  </Td>
                  <Td className="border-b-0">
                    <ReviewerCell reviewerId={report.reviewedBy} reviewers={history.reviewers} />
                  </Td>
                </tr>
                <RationaleRow columnCount={6} note={report.resolutionNote} />
              </Fragment>
            ))}
          </DataTable>
        )}

        <Pagination
          basePath="/admin/moderation/history"
          offsetParam="subjects"
          offset={history.subjectOffset}
          pageSize={history.pageSize}
          total={history.totals.subjectReports}
          otherParams={history.postOffset > 0 ? { posts: String(history.postOffset) } : {}}
          noun="subject decisions"
        />
      </section>
    </>
  );
}
