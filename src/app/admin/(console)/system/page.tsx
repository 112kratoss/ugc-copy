import { Mail } from 'lucide-react';

import { Surface, Text } from '@/app/components/DesignSystem';
import { CONTACT_PAGE_SIZE, collectAdminSystemSnapshot } from '@/lib/admin-system-service';
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
} from '../AdminUi';

export const dynamic = 'force-dynamic';

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export default async function AdminSystemPage({
  searchParams,
}: {
  searchParams: Promise<{ contact?: string }>;
}) {
  const { contact } = await searchParams;
  const contactOffset = parseOffset(contact, CONTACT_PAGE_SIZE);
  const snapshot = await collectAdminSystemSnapshot(createServiceClient(), { contactOffset });

  const failingJobs = snapshot.jobSummaries.filter((job) => job.failureCount24h > 0);
  const now = new Date();
  const heldLocks = snapshot.locks.filter(
    (lock) => lock.lockedUntil && new Date(lock.lockedUntil) > now,
  );

  return (
    <>
      <PageHeader
        title="System"
        description="Cron job registry, model catalog control plane, and the inbound contact queue."
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Jobs run 24h" value={snapshot.jobSummaries.reduce((total, job) => total + job.runCount24h, 0)} />
        <StatCard
          label="Jobs failing"
          value={failingJobs.length}
          tone={failingJobs.length > 0 ? 'danger' : 'ok'}
        />
        <StatCard label="Locks held" value={heldLocks.length} tone={heldLocks.length > 0 ? 'warning' : 'neutral'} />
        <StatCard
          label="Catalog models"
          value={snapshot.catalog.entryCount}
          hint={snapshot.catalog.activeRevision ? `rev ${snapshot.catalog.activeRevision}` : 'no active release'}
        />
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Job health (24h)</Text>
        {snapshot.jobSummaries.length === 0 ? (
          <EmptyState message="No job runs in the last 24 hours." />
        ) : (
          <DataTable columns={['Job', 'Last status', 'Last run', 'Runs 24h', 'Failures 24h']}>
            {snapshot.jobSummaries.map((job) => (
              <tr key={job.jobName}>
                <Td mono>{job.jobName}</Td>
                <Td><StatusBadge status={job.lastStatus} /></Td>
                <Td>{formatRelative(job.lastRunAt)}</Td>
                <Td>{job.runCount24h}</Td>
                <Td className={job.failureCount24h > 0 ? 'font-bold text-[var(--ui-accent-danger)]' : undefined}>
                  {job.failureCount24h}
                </Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Recent runs</Text>
        {snapshot.recentRuns.length === 0 ? (
          <EmptyState message="No job runs recorded." />
        ) : (
          <DataTable columns={['Started', 'Job', 'Status', 'Duration', 'Skip reason', 'Error']}>
            {snapshot.recentRuns.map((run) => (
              <tr key={run.id}>
                <Td>{formatTimestamp(run.startedAt)}</Td>
                <Td mono>{run.jobName}</Td>
                <Td><StatusBadge status={run.status} /></Td>
                <Td>{formatDuration(run.durationMs)}</Td>
                <Td>{run.skipReason ?? '—'}</Td>
                <Td truncateWidth={240}>{run.errorMessage ?? '—'}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Job locks</Text>
        {snapshot.locks.length === 0 ? (
          <EmptyState message="No job locks recorded." />
        ) : (
          <DataTable columns={['Lock', 'Locked until', 'Owner', 'State']}>
            {snapshot.locks.map((lock) => {
              const held = Boolean(lock.lockedUntil && new Date(lock.lockedUntil) > now);
              return (
                <tr key={lock.name}>
                  <Td mono>{lock.name}</Td>
                  <Td>{formatTimestamp(lock.lockedUntil)}</Td>
                  <Td mono>{lock.lockedBy ?? '—'}</Td>
                  <Td><StatusBadge status={held ? 'held' : 'free'} tone={held ? 'warning' : 'ok'} /></Td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Generation model catalog</Text>
        <Surface variant="card" padding="md" className="mb-3">
          <Text variant="bodySm">
            Releases are staged and published with{' '}
            <code className="font-mono text-[var(--ui-text-secondary)]">npm run ops:generation-model-catalog</code>.
            This view is read-only — publishing from a browser would bypass the revision-guarded
            validate → diff → stage → verify workflow.
          </Text>
        </Surface>

        {snapshot.catalog.releases.length === 0 ? (
          <EmptyState message="No catalog releases found." />
        ) : (
          <DataTable columns={['Revision', 'Status', 'Created', 'Change note']}>
            {snapshot.catalog.releases.map((release) => (
              <tr key={release.id}>
                <Td mono>{release.revision}</Td>
                <Td><StatusBadge status={release.status} /></Td>
                <Td>{formatTimestamp(release.createdAt)}</Td>
                <Td truncateWidth={320}>{release.changeNote ?? '—'}</Td>
              </tr>
            ))}
          </DataTable>
        )}
      </section>

      <section className="mt-8">
        <Text as="h2" variant="cardTitle" className="mb-3">Contact messages</Text>
        {snapshot.contactMessages.length === 0 ? (
          <EmptyState message="No contact messages." />
        ) : (
          <div className="flex flex-col gap-2">
            {snapshot.contactMessages.map((message) => (
              <Surface key={message.id} variant="card" padding="md">
                {/*
                  A native <details> keeps the queue scannable without shipping
                  a client component: the body is the whole point of the record,
                  but forty expanded enquiries are unreadable at a glance.
                */}
                <details className="group">
                  <summary className="ui-focus-ring flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-lg">
                    <div className="min-w-0">
                      <Text as="span" variant="label">{message.subject || 'No subject'}</Text>
                      <Text variant="caption" className="mt-0.5 block">
                        {message.name} · {formatRelative(message.createdAt)}
                      </Text>
                    </div>
                    <a
                      href={`mailto:${message.email}?subject=${encodeURIComponent(`Re: ${message.subject}`)}`}
                      className="ui-button ui-button-secondary ui-focus-ring shrink-0"
                    >
                      <Mail className="h-4 w-4" aria-hidden />
                      Reply
                    </a>
                  </summary>

                  <div className="mt-3 border-t border-[var(--ui-border-subtle)] pt-3">
                    <Text variant="bodySm" className="whitespace-pre-wrap text-[var(--ui-text-secondary)]">
                      {message.message || 'No message body recorded.'}
                    </Text>
                    <Text variant="caption" className="mt-3 block font-mono">
                      {message.email} · {formatTimestamp(message.createdAt)}
                    </Text>
                  </div>
                </details>
              </Surface>
            ))}
          </div>
        )}

        <Pagination
          basePath="/admin/system"
          offsetParam="contact"
          offset={snapshot.contactOffset}
          pageSize={CONTACT_PAGE_SIZE}
          total={snapshot.contactMessageTotal}
          noun="contact messages"
        />
      </section>
    </>
  );
}
