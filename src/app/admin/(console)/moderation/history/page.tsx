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
 * A decision with no rationale predates the mandatory-note rule, and saying so
 * is more useful than an em dash that reads like a rendering bug.
 */
function ResolutionNote({ note }: { note: string | null }) {
  if (!note) {
    return <span className="italic text-[var(--ui-text-faint)]">No note recorded</span>;
  }
  return <>{note}</>;
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
          <DataTable columns={['Decided', 'Action', 'Reason', 'Post', 'Reviewer', 'Rationale']}>
            {history.postReports.map((report) => (
              <tr key={report.id}>
                <Td>{formatTimestamp(report.reviewedAt)}</Td>
                <Td>
                  <StatusBadge
                    status={report.resolutionAction ?? report.status}
                    tone={report.resolutionAction === 'take_down' ? 'danger' : 'ok'}
                  />
                </Td>
                <Td><StatusBadge status={report.reason} tone="warning" /></Td>
                <Td truncateWidth={220}>
                  <Link href={`/post/${report.postId}`} target="_blank" rel="noreferrer" className="underline">
                    {report.post?.title || 'Untitled post'}
                  </Link>
                </Td>
                <Td><ReviewerCell reviewerId={report.reviewedBy} reviewers={history.reviewers} /></Td>
                <Td truncateWidth={320}><ResolutionNote note={report.resolutionNote} /></Td>
              </tr>
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
          <DataTable columns={['Decided', 'Outcome', 'Target', 'Reason', 'Subject', 'Reviewer', 'Rationale']}>
            {history.subjectReports.map((report) => (
              <tr key={report.id}>
                <Td>{formatTimestamp(report.reviewedAt)}</Td>
                <Td>
                  <StatusBadge
                    status={report.status}
                    tone={report.status === 'resolved' ? 'danger' : 'ok'}
                  />
                </Td>
                <Td><StatusBadge status={report.targetType} tone="neutral" /></Td>
                <Td><StatusBadge status={report.reason} tone="warning" /></Td>
                <Td>
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
                <Td><ReviewerCell reviewerId={report.reviewedBy} reviewers={history.reviewers} /></Td>
                <Td truncateWidth={320}><ResolutionNote note={report.resolutionNote} /></Td>
              </tr>
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
