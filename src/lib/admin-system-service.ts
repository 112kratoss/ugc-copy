import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { runPagedQuery } from '@/lib/admin-paged-query';

/**
 * Read models for the admin System area: the cron job registry, the generation
 * model catalog control plane, and the inbound contact queue.
 *
 * Job health here is intentionally raw run history. The interpreted view —
 * thresholds, warning and degraded states — already lives in
 * `backend-health.ts` and is surfaced on the Overview page instead of being
 * re-derived with a second set of rules.
 */

export type AdminJobRun = {
  id: string;
  jobName: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  skipReason: string | null;
  errorMessage: string | null;
};

export type AdminJobSummary = {
  jobName: string;
  lastStatus: string;
  lastRunAt: string | null;
  failureCount24h: number;
  runCount24h: number;
};

export type AdminSystemSnapshot = {
  jobSummaries: AdminJobSummary[];
  recentRuns: AdminJobRun[];
  locks: Array<{ name: string; lockedUntil: string | null; lockedBy: string | null }>;
  catalog: {
    activeRevision: string | null;
    activeStatus: string | null;
    activatedAt: string | null;
    entryCount: number;
    releases: Array<{ id: string; revision: string; status: string; createdAt: string; changeNote: string | null }>;
  };
  contactMessages: Array<{
    id: string;
    name: string;
    email: string;
    subject: string;
    /** The actual enquiry. Without it the queue is a list of senders, not a queue. */
    message: string;
    createdAt: string;
  }>;
  contactMessageTotal: number;
  /** Where the contact list actually landed; see `runPagedQuery`. */
  contactOffset: number;
};

export const CONTACT_PAGE_SIZE = 25;

export async function collectAdminSystemSnapshot(
  client: SupabaseClient,
  options: { now?: Date; contactOffset?: number } = {},
): Promise<AdminSystemSnapshot> {
  const contactOffset = Math.max(options.contactOffset ?? 0, 0);
  const now = options.now ?? new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [runs, dayRuns, locks, releases, contact] = await Promise.all([
    client
      .from('backend_job_runs')
      .select('id, job_name, status, started_at, finished_at, duration_ms, skip_reason, error_message')
      .order('started_at', { ascending: false })
      .limit(60),
    client
      .from('backend_job_runs')
      .select('job_name, status, started_at')
      .gte('started_at', dayAgo)
      .limit(2000),
    client
      .from('backend_job_locks')
      .select('name, locked_until, locked_by')
      .order('name', { ascending: true })
      .limit(50),
    client
      .from('generation_model_catalog_releases')
      .select('id, revision, status, change_note, created_at, activated_at')
      .order('created_at', { ascending: false })
      .limit(10),
    runPagedQuery<Record<string, unknown>>(
      (from, to) => client
        .from('contact_messages')
        .select('id, name, email, subject, message, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to),
      { offset: contactOffset, pageSize: CONTACT_PAGE_SIZE },
    ),
  ]);

  // `contact` is omitted: runPagedQuery already threw on any error it saw.
  for (const result of [runs, dayRuns, locks, releases]) {
    if (result.error) throw result.error;
  }

  const dayRunRows = (dayRuns.data ?? []) as Array<Record<string, unknown>>;
  const summaryByJob = new Map<string, AdminJobSummary>();

  for (const row of dayRunRows) {
    const jobName = String(row.job_name ?? '');
    const status = String(row.status ?? '');
    const startedAt = (row.started_at as string | null) ?? null;
    const existing = summaryByJob.get(jobName);

    if (!existing) {
      summaryByJob.set(jobName, {
        jobName,
        lastStatus: status,
        lastRunAt: startedAt,
        failureCount24h: status === 'failed' ? 1 : 0,
        runCount24h: 1,
      });
      continue;
    }

    existing.runCount24h += 1;
    if (status === 'failed') existing.failureCount24h += 1;
    // Rows arrive newest-first, so the first sighting is already the latest run;
    // only replace it if an out-of-order row is genuinely newer.
    if (startedAt && (!existing.lastRunAt || startedAt > existing.lastRunAt)) {
      existing.lastRunAt = startedAt;
      existing.lastStatus = status;
    }
  }

  const releaseRows = (releases.data ?? []) as Array<Record<string, unknown>>;
  const activeRelease = releaseRows.find((row) => String(row.status ?? '') === 'active') ?? null;

  let entryCount = 0;
  if (activeRelease) {
    const entries = await client
      .from('generation_model_catalog_entries')
      .select('model_id', { count: 'exact', head: true })
      .eq('release_id', activeRelease.id as string);
    if (entries.error) throw entries.error;
    entryCount = entries.count ?? 0;
  }

  return {
    jobSummaries: [...summaryByJob.values()].sort((left, right) => left.jobName.localeCompare(right.jobName)),
    recentRuns: ((runs.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      jobName: String(row.job_name ?? ''),
      status: String(row.status ?? ''),
      startedAt: (row.started_at as string | null) ?? null,
      finishedAt: (row.finished_at as string | null) ?? null,
      durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : null,
      skipReason: (row.skip_reason as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
    })),
    locks: ((locks.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      name: String(row.name ?? ''),
      lockedUntil: (row.locked_until as string | null) ?? null,
      lockedBy: (row.locked_by as string | null) ?? null,
    })),
    catalog: {
      activeRevision: activeRelease ? String(activeRelease.revision ?? '') : null,
      activeStatus: activeRelease ? String(activeRelease.status ?? '') : null,
      activatedAt: activeRelease ? ((activeRelease.activated_at as string | null) ?? null) : null,
      entryCount,
      releases: releaseRows.map((row) => ({
        id: String(row.id),
        revision: String(row.revision ?? ''),
        status: String(row.status ?? ''),
        createdAt: String(row.created_at ?? ''),
        changeNote: (row.change_note as string | null) ?? null,
      })),
    },
    contactMessages: contact.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      email: String(row.email ?? ''),
      subject: String(row.subject ?? ''),
      message: String(row.message ?? ''),
      createdAt: String(row.created_at ?? ''),
    })),
    contactMessageTotal: contact.total,
    contactOffset: contact.offset,
  };
}
