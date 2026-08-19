import Link from 'next/link';
import { ExternalLink, History } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';
import { collectAdminModerationQueue } from '@/lib/admin-moderation-service';
import { createServiceClient } from '@/lib/server-helpers';

import { EmptyState, PageHeader, StatCard, StatusBadge, formatRelative, formatTimestamp, shortId } from '../AdminUi';
import { PostReportActions, SubjectReportActions } from './ModerationActions';

export const dynamic = 'force-dynamic';

/** Matches the SLOs documented in docs/moderation-operations.md. */
const QUEUE_AGE_WARNING_MINUTES = 4 * 60;
const QUEUE_AGE_BREACH_MINUTES = 24 * 60;

function queueAgeTone(oldestOpenAt: string | null) {
  if (!oldestOpenAt) return 'ok' as const;
  const ageMinutes = (Date.now() - new Date(oldestOpenAt).getTime()) / 60000;
  if (ageMinutes >= QUEUE_AGE_BREACH_MINUTES) return 'danger' as const;
  if (ageMinutes >= QUEUE_AGE_WARNING_MINUTES) return 'warning' as const;
  return 'ok' as const;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text as="span" variant="caption" className="uppercase tracking-[0.08em]">{label}</Text>
      <div className="mt-0.5 text-sm text-[var(--ui-text-secondary)]">{children}</div>
    </div>
  );
}

export default async function AdminModerationPage() {
  const queue = await collectAdminModerationQueue(createServiceClient());

  return (
    <>
      <PageHeader
        title="Moderation"
        description="Open reports across posts, comments, users, and generations. Every decision records your reviewer id."
        actions={
          <Link href="/admin/moderation/history" className="ui-button ui-button-secondary ui-focus-ring">
            <History className="h-4 w-4" aria-hidden />
            Decision history
          </Link>
        }
      />

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Open reports"
          value={queue.openCount}
          tone={queue.openCount >= 25 ? 'danger' : queue.openCount >= 10 ? 'warning' : 'ok'}
          hint="Warns at 10, degrades at 25"
        />
        <StatCard label="Post reports" value={queue.postReports.length} />
        <StatCard
          label="Oldest open"
          value={formatRelative(queue.oldestOpenAt)}
          tone={queueAgeTone(queue.oldestOpenAt)}
          hint="4h warning · 24h SLO breach"
        />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">
          Post reports ({queue.postReports.length})
        </Text>

        {queue.postReports.length === 0 ? (
          <EmptyState message="No open post reports." />
        ) : (
          <div className="flex flex-col gap-3">
            {queue.postReports.map((report) => (
              <Surface key={report.id} variant="card" padding="md">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={report.reason} tone="warning" />
                      <StatusBadge status={report.status} />
                      <Text as="span" variant="caption">{formatRelative(report.createdAt)}</Text>
                    </div>
                    <Text as="p" variant="label" className="mt-2 truncate">
                      {report.post?.title || 'Untitled post'}
                    </Text>
                  </div>
                  {report.post ? (
                    <Link
                      href={`/post/${report.postId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ui-button ui-button-secondary ui-focus-ring shrink-0"
                    >
                      View post
                      <ExternalLink className="h-4 w-4" aria-hidden />
                    </Link>
                  ) : null}
                </div>

                {report.details ? (
                  <blockquote className="mt-3 rounded-xl border-l-2 border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-3 py-2">
                    <Text variant="bodySm">{report.details}</Text>
                  </blockquote>
                ) : null}

                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Report id"><span className="font-mono text-xs">{shortId(report.id)}</span></Field>
                  <Field label="Post id"><span className="font-mono text-xs">{shortId(report.postId)}</span></Field>
                  <Field label="Author">
                    {report.post ? (
                      <Link href={`/admin/users/${report.post.userId}`} className="font-mono text-xs underline">
                        {shortId(report.post.userId)}
                      </Link>
                    ) : '—'}
                  </Field>
                  <Field label="Visibility">{report.post?.visibility ?? '—'}</Field>
                  <Field label="Review status">{report.post?.reviewStatus ?? '—'}</Field>
                  <Field label="Report count">{report.post?.reportCount ?? '—'}</Field>
                  <Field label="Bundle">{report.bundleId ? shortId(report.bundleId) : '—'}</Field>
                  <Field label="Reported at">{formatTimestamp(report.createdAt)}</Field>
                </div>

                <PostReportActions reportId={report.id} />
              </Surface>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">
          User, generation & comment reports ({queue.subjectReports.length})
        </Text>

        {queue.subjectReports.length === 0 ? (
          <EmptyState message="No open subject reports." />
        ) : (
          <div className="flex flex-col gap-3">
            {queue.subjectReports.map((report) => (
              <Surface key={report.id} variant="card" padding="md">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={report.targetType} tone="neutral" />
                  <StatusBadge status={report.reason} tone="warning" />
                  <StatusBadge status={report.status} />
                  <Text as="span" variant="caption">{formatRelative(report.createdAt)}</Text>
                </div>

                {report.details ? (
                  <blockquote className="mt-3 rounded-xl border-l-2 border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-3 py-2">
                    <Text variant="bodySm">{report.details}</Text>
                  </blockquote>
                ) : null}

                {/*
                  The queue already hydrates the comment body, so showing only an
                  id forced the operator to go find the evidence elsewhere before
                  they could decide. Render it inline.
                */}
                {report.comment ? (
                  <div className="mt-3 rounded-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Text as="span" variant="caption" className="uppercase tracking-[0.08em]">
                        Reported comment
                      </Text>
                      <StatusBadge status={report.comment.status} />
                      <Link
                        href={`/post/${report.comment.postId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline"
                      >
                        Open post
                      </Link>
                    </div>
                    <Text variant="bodySm" className="mt-1.5 whitespace-pre-wrap text-[var(--ui-text-secondary)]">
                      {report.comment.body}
                    </Text>
                    {report.comment.parentId ? (
                      <Text variant="caption" className="mt-1">Reply to {shortId(report.comment.parentId)}</Text>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Report id"><span className="font-mono text-xs">{shortId(report.id)}</span></Field>
                  <Field label="Surface">{report.sourceSurface}</Field>
                  <Field label="Reported user">
                    {report.reportedUserId ? (
                      <Link href={`/admin/users/${report.reportedUserId}`} className="font-mono text-xs underline">
                        {shortId(report.reportedUserId)}
                      </Link>
                    ) : '—'}
                  </Field>
                  <Field label="Comment author">
                    {report.comment?.authorUserId ? (
                      <Link href={`/admin/users/${report.comment.authorUserId}`} className="font-mono text-xs underline">
                        {shortId(report.comment.authorUserId)}
                      </Link>
                    ) : '—'}
                  </Field>
                  <Field label="Generation">{report.generationId ? shortId(report.generationId) : '—'}</Field>
                  <Field label="Reported at">{formatTimestamp(report.createdAt)}</Field>
                </div>

                <SubjectReportActions reportId={report.id} />
              </Surface>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
