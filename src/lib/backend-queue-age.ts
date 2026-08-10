import { BACKEND_JOB_REGISTRY, type BackendJobName } from '@/lib/backend-jobs';

/**
 * F14 — queue-age SLOs.
 *
 * The registry already answers "did this job run?" via
 * `healthExpectedMaxAgeMinutes`. That is job *liveness*, and it is not the same
 * question as queue *age*: a job can run exactly on schedule, every time, while
 * its backlog grows without bound. F13 was that shape — a refresh that ran
 * hourly and permanently starved every row past the first thousand. Liveness
 * was green throughout.
 *
 * The certification gate asks for "queue age below twice its cadence", so the
 * SLO is derived from each queue's owning job rather than hand-set. Deriving it
 * means a schedule change moves the SLO with it; a hand-set constant would
 * quietly keep asserting the old cadence, which is the drift F14 already
 * guarded against by asserting `vercel.json` against this same registry.
 */

export const QUEUE_AGE_SLO_CADENCE_MULTIPLIER = 2;

/**
 * Past twice the SLO, the queue is not slipping — it is not draining. Split so
 * an alert can distinguish "slower than intended" from "broken", because one is
 * worth a look on Monday and the other is worth waking up for.
 */
export const QUEUE_AGE_DEGRADED_CADENCE_MULTIPLIER = 4;
const QUEUE_LEASE_TTL_SECONDS = 300;

export type BackendQueueAgeStatus = 'ok' | 'warning' | 'degraded';

export type BackendQueueAgeEntry = {
  queue: string;
  job: BackendJobName;
  cadenceMinutes: number;
  sloMinutes: number;
  degradedMinutes: number;
  oldestDueAt: string | null;
  ageMinutes: number | null;
  /**
   * False when the probe failed. Tracked separately from `ageMinutes: null`,
   * which is the *empty queue* answer — the two look identical in the data and
   * mean opposite things, and conflating them is how a blind monitor reports
   * itself healthy.
   */
  readable: boolean;
  status: BackendQueueAgeStatus;
};

export type BackendQueueAgeHealth = {
  status: BackendQueueAgeStatus;
  sloCadenceMultiplier: number;
  queues: BackendQueueAgeEntry[];
};

export type BackendQueueAgeIssue = {
  severity: 'warning' | 'degraded';
  code: string;
  message: string;
};

type QueueProbeResult = { data: { oldest: string | null } | null; error: unknown };

type QueueDefinition = {
  queue: string;
  job: BackendJobName;
  /**
   * Resolves the oldest item that is *due*, as an ISO timestamp.
   *
   * Deliberately a targeted "oldest one row" read rather than a filter over one
   * of the health collectors' capped samples. A sample makes queue age
   * optimistic exactly when the queue is deep enough to matter — the true
   * oldest item falls outside the cap — which is the silent-optimism failure
   * F15a was filed for. Reporting a wrong age is worse than reporting none.
   */
  probe: (client: QueueClient, nowIso: string) => PromiseLike<QueueProbeResult>;
};

export type QueueClient = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => QueueFilter;
      eq: (column: string, value: unknown) => QueueFilter;
      or: (filters: string) => QueueFilter;
    };
  };
};

type QueueFilter = {
  lte: (column: string, value: string) => QueueFilter;
  in: (column: string, values: string[]) => QueueFilter;
  or: (filters: string) => QueueFilter;
  order: (column: string, options: { ascending: boolean }) => QueueFilter;
  limit: (count: number) => QueueFilter;
  maybeSingle: () => PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
};

function readTimestamp(data: Record<string, unknown> | null, column: string): string | null {
  const value = data?.[column];
  return typeof value === 'string' ? value : null;
}

const QUEUE_DEFINITIONS: QueueDefinition[] = [
  {
    queue: 'generation_completion_jobs',
    job: 'generation-completions',
    probe: async (client, nowIso) => {
      // `next_attempt_at`, not `created_at`: an item deliberately deferred by
      // backoff is not late, and ageing it from creation would report a healthy
      // retry schedule as a permanent breach.
      const { data, error } = await client
        .from('generation_completion_jobs')
        .select('next_attempt_at')
        .or([
          `and(status.eq.pending,next_attempt_at.lte.${nowIso})`,
          // Completion jobs have no heartbeat column. Their claim contract
          // reclaims processing rows solely from locked_at, so health must use
          // that exact lease clock instead of querying a column that exists
          // only on workflow_run_step_jobs.
          `and(status.eq.processing,locked_at.lte.${new Date(Date.parse(nowIso) - QUEUE_LEASE_TTL_SECONDS * 1000).toISOString()})`,
        ].join(','))
        .order('next_attempt_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      return { data: { oldest: readTimestamp(data, 'next_attempt_at') }, error };
    },
  },
  {
    queue: 'generation_output_import_jobs',
    job: 'generation-completions',
    probe: async (client, nowIso) => {
      const staleIso = new Date(
        Date.parse(nowIso) - QUEUE_LEASE_TTL_SECONDS * 1000,
      ).toISOString();
      const { data, error } = await client
        .from('generation_output_import_jobs')
        .select('next_attempt_at')
        .or([
          `and(status.eq.pending,next_attempt_at.lte.${nowIso})`,
          `and(status.eq.processing,locked_at.lte.${staleIso})`,
        ].join(','))
        .order('next_attempt_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      return { data: { oldest: readTimestamp(data, 'next_attempt_at') }, error };
    },
  },
  {
    queue: 'workflow_run_step_jobs',
    job: 'workflow-run-steps',
    probe: async (client, nowIso) => {
      // F12 landed this queue with claims, leases and backoff, but wired it
      // into no health surface at all — a durable queue nobody was watching.
      const { data, error } = await client
        .from('workflow_run_step_jobs')
        .select('next_attempt_at')
        .or([
          `and(status.eq.pending,next_attempt_at.lte.${nowIso})`,
          `and(status.eq.processing,heartbeat_at.lte.${new Date(Date.parse(nowIso) - QUEUE_LEASE_TTL_SECONDS * 1000).toISOString()})`,
          `and(status.eq.processing,heartbeat_at.is.null,locked_at.lte.${new Date(Date.parse(nowIso) - QUEUE_LEASE_TTL_SECONDS * 1000).toISOString()})`,
        ].join(','))
        .order('next_attempt_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      return { data: { oldest: readTimestamp(data, 'next_attempt_at') }, error };
    },
  },
  {
    queue: 'template_run_jobs',
    job: 'workflow-run-steps',
    probe: async (client, nowIso) => {
      const staleIso = new Date(
        Date.parse(nowIso) - QUEUE_LEASE_TTL_SECONDS * 1000,
      ).toISOString();
      const { data, error } = await client
        .from('template_run_jobs')
        .select('next_attempt_at')
        .or([
          `and(status.eq.pending,next_attempt_at.lte.${nowIso})`,
          `and(status.eq.processing,heartbeat_at.lte.${staleIso})`,
          `and(status.eq.processing,heartbeat_at.is.null,locked_at.lte.${staleIso})`,
        ].join(','))
        .order('next_attempt_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      return { data: { oldest: readTimestamp(data, 'next_attempt_at') }, error };
    },
  },
  {
    queue: 'post_media_renditions',
    job: 'media-preview-repair',
    probe: async (client) => {
      // No next_attempt_at on this one, so age runs from creation. That is the
      // honest reading here: an unresolved rendition has been serving
      // full-bitrate source video to every viewer since the moment it existed.
      const { data, error } = await client
        .from('post_media')
        .select('created_at')
        .eq('media_kind', 'video')
        .in('rendition_status', ['pending', 'processing'])
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      return { data: { oldest: readTimestamp(data, 'created_at') }, error };
    },
  },
];

function cadenceMinutesFor(job: BackendJobName): number {
  const definition = BACKEND_JOB_REGISTRY.find((entry) => entry.name === job);
  if (!definition) {
    throw new Error(`Queue-age SLO references unknown backend job: ${job}`);
  }
  return definition.cadenceMinutes;
}

function minutesBetween(from: string, now: Date): number {
  const parsed = Date.parse(from);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (now.getTime() - parsed) / 60000);
}

export function buildQueueAgeEntry(params: {
  queue: string;
  job: BackendJobName;
  oldestDueAt: string | null;
  now: Date;
  readable?: boolean;
}): BackendQueueAgeEntry {
  const cadenceMinutes = cadenceMinutesFor(params.job);
  const sloMinutes = cadenceMinutes * QUEUE_AGE_SLO_CADENCE_MULTIPLIER;
  const degradedMinutes = cadenceMinutes * QUEUE_AGE_DEGRADED_CADENCE_MULTIPLIER;
  const readable = params.readable !== false;
  const ageMinutes = !readable || params.oldestDueAt === null
    ? null
    : Math.round(minutesBetween(params.oldestDueAt, params.now) * 10) / 10;

  let status: BackendQueueAgeStatus = 'ok';
  if (!readable) {
    // Not knowing is not the same as being fine. F15a's whole finding was that
    // monitoring which cannot see gets *more* optimistic, not less.
    status = 'warning';
  } else if (ageMinutes !== null && ageMinutes > degradedMinutes) {
    status = 'degraded';
  } else if (ageMinutes !== null && ageMinutes > sloMinutes) {
    status = 'warning';
  }

  return {
    queue: params.queue,
    job: params.job,
    cadenceMinutes,
    sloMinutes,
    degradedMinutes,
    oldestDueAt: readable ? params.oldestDueAt : null,
    ageMinutes,
    readable,
    status,
  };
}

/**
 * An empty queue is `ok` with a null age, never zero. Zero would read as "the
 * oldest item is brand new", which is a different and much less reassuring
 * statement than "there is nothing waiting".
 */
export async function collectBackendQueueAgeHealth(
  client: QueueClient,
  now: Date = new Date(),
): Promise<{ health: BackendQueueAgeHealth; issues: BackendQueueAgeIssue[] }> {
  const nowIso = now.toISOString();

  const queues = await Promise.all(QUEUE_DEFINITIONS.map(async (definition) => {
    try {
      const { data, error } = await definition.probe(client, nowIso);
      if (error) throw error instanceof Error ? error : new Error(String(error));
      return buildQueueAgeEntry({
        queue: definition.queue,
        job: definition.job,
        oldestDueAt: data?.oldest ?? null,
        now,
      });
    } catch {
      // An unreadable queue is flagged, never silently passed as healthy.
      return buildQueueAgeEntry({
        queue: definition.queue,
        job: definition.job,
        oldestDueAt: null,
        now,
        readable: false,
      });
    }
  }));

  const issues: BackendQueueAgeIssue[] = queues
    .filter((entry) => entry.status !== 'ok')
    .map((entry) => {
      if (!entry.readable) {
        return {
          severity: 'warning' as const,
          code: 'QUEUE_AGE_UNREADABLE',
          message: `${entry.queue} could not be probed, so its queue age is unknown. Treat this as unmonitored rather than healthy.`,
        };
      }

      return {
        severity: entry.status === 'degraded' ? 'degraded' as const : 'warning' as const,
        code: entry.status === 'degraded' ? 'QUEUE_AGE_NOT_DRAINING' : 'QUEUE_AGE_SLO_BREACH',
        message: `${entry.queue} has work waiting ${entry.ageMinutes} minute(s), past its ${entry.sloMinutes}-minute SLO (${entry.cadenceMinutes}-minute cadence × ${QUEUE_AGE_SLO_CADENCE_MULTIPLIER}).`,
      };
    });

  const status: BackendQueueAgeStatus = queues.some((entry) => entry.status === 'degraded')
    ? 'degraded'
    : queues.some((entry) => entry.status === 'warning')
      ? 'warning'
      : 'ok';

  return {
    health: { status, sloCadenceMultiplier: QUEUE_AGE_SLO_CADENCE_MULTIPLIER, queues },
    issues,
  };
}
