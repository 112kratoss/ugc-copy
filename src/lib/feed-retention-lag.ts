import {
  FEED_EVENT_RETENTION_DAYS,
  FEED_FACT_RETENTION_DAYS,
} from '@/lib/feed-retention-policy';

/**
 * F7b — retention lag for the feed telemetry tables.
 *
 * Growth reporting and retention lag answer different questions, and only the
 * second one catches a prune that has stopped keeping up. `prune_feed_
 * personalization_data` deletes at most `FEED_RETENTION_PRUNE_LIMIT` (5,000)
 * rows an hour, so once the insert rate exceeds that ceiling the oldest row
 * ages past its window and the table simply looks "large" — which is
 * indistinguishable from ordinary growth in a row-count budget.
 *
 * Lag is measured in days past the configured window, so a table pruning
 * correctly reads 0 no matter how big it is.
 */

export const FEED_RETENTION_WINDOWS: Record<string, number> = {
  feed_delivery_facts: FEED_FACT_RETENTION_DAYS,
  feed_events: FEED_EVENT_RETENTION_DAYS,
};

/**
 * The sweep runs hourly and deletes in capped batches, so the oldest row is
 * expected to sit slightly past the window between runs. Two days absorbs a
 * missed run or a backlog draining normally; a week means it is not draining.
 */
export const FEED_RETENTION_LAG_WARNING_DAYS = 2;
export const FEED_RETENTION_LAG_DEGRADED_DAYS = 7;

export type FeedRetentionLagStatus = 'ok' | 'warning' | 'degraded';

export type FeedRetentionLagEntry = {
  tableName: string;
  retentionDays: number;
  oldestRowAt: string | null;
  ageDays: number | null;
  /** Days past the retention window; 0 when the sweep is keeping up. */
  lagDays: number;
  rowCount: number;
  status: FeedRetentionLagStatus;
};

export type FeedRetentionLagIssue = {
  severity: 'warning' | 'degraded';
  code: 'FEED_RETENTION_LAG';
  tableName: string;
  message: string;
};

export type FeedRetentionLagReport = {
  status: FeedRetentionLagStatus;
  tables: FeedRetentionLagEntry[];
  issues: FeedRetentionLagIssue[];
};

type RetentionLagClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // bigint columns arrive as strings over PostgREST.
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function buildFeedRetentionLagEntry(params: {
  tableName: string;
  oldestRowAt: string | null;
  rowCount: number;
  now: Date;
}): FeedRetentionLagEntry {
  const retentionDays = FEED_RETENTION_WINDOWS[params.tableName] ?? 0;
  const parsed = params.oldestRowAt === null ? NaN : Date.parse(params.oldestRowAt);
  const ageDays = Number.isFinite(parsed)
    ? Math.max(0, (params.now.getTime() - parsed) / 86_400_000)
    : null;

  // An empty table is `ok` with a null age rather than a zero one. Zero would
  // read as "the oldest row is brand new", which is a different claim from
  // "there is nothing retained".
  const lagDays = ageDays === null || retentionDays === 0
    ? 0
    : Math.max(0, Math.round((ageDays - retentionDays) * 10) / 10);

  let status: FeedRetentionLagStatus = 'ok';
  if (lagDays > FEED_RETENTION_LAG_DEGRADED_DAYS) status = 'degraded';
  else if (lagDays > FEED_RETENTION_LAG_WARNING_DAYS) status = 'warning';

  return {
    tableName: params.tableName,
    retentionDays,
    oldestRowAt: params.oldestRowAt,
    ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
    lagDays,
    rowCount: params.rowCount,
    status,
  };
}

/**
 * The parameter is deliberately not called `now`.
 *
 * It was, and passing it on as the object shorthand `{ ..., now }` produced a
 * build that threw `ReferenceError: now is not defined` at runtime — the
 * minifier inlined `buildFeedRetentionLagEntry` here, renamed the enclosing
 * parameter, and left the shorthand's implicit reference pointing at the old
 * name. Source, unit tests and typecheck all pass, because the fault is
 * introduced by the bundler; only the built artifact is broken, and the health
 * endpoint 500s. Naming the parameter differently forces an explicit
 * `now: asOf` and removes the shorthand the inliner mishandles.
 */
export function normalizeFeedRetentionLagRows(data: unknown, asOf: Date): FeedRetentionLagEntry[] {
  if (!Array.isArray(data)) return [];

  return data.flatMap((row) => {
    if (!isRecord(row)) return [];
    const tableName = typeof row.table_name === 'string' ? row.table_name : null;
    if (!tableName) return [];
    return [buildFeedRetentionLagEntry({
      tableName,
      oldestRowAt: typeof row.oldest_row_at === 'string' ? row.oldest_row_at : null,
      rowCount: toCount(row.row_count),
      now: asOf,
    })];
  });
}

export async function collectFeedRetentionLag(
  client: RetentionLagClient,
  now: Date = new Date(),
): Promise<FeedRetentionLagReport> {
  let rows: unknown;

  try {
    const { data, error } = await client.rpc('get_feed_retention_lag', {});
    if (error) throw error instanceof Error ? error : new Error(String(error));
    rows = data;
  } catch {
    // Unavailable is reported, never treated as healthy — the same posture
    // F15a established for truncated samples. Caught rather than error-checked
    // because a database missing the RPC, and a client that cannot call it at
    // all, are the same fact to a monitor.
    return {
      status: 'warning',
      tables: [],
      issues: [{
        severity: 'warning',
        code: 'FEED_RETENTION_LAG',
        tableName: '-',
        message: 'Feed retention lag could not be measured because get_feed_retention_lag is unavailable. Treat retention as unmonitored rather than healthy.',
      }],
    };
  }

  const tables = normalizeFeedRetentionLagRows(rows, now);
  const issues: FeedRetentionLagIssue[] = tables
    .filter((entry) => entry.status !== 'ok')
    .map((entry) => ({
      severity: entry.status === 'degraded' ? 'degraded' as const : 'warning' as const,
      code: 'FEED_RETENTION_LAG' as const,
      tableName: entry.tableName,
      message: `${entry.tableName} retains rows ${entry.ageDays} day(s) old against a ${entry.retentionDays}-day window (${entry.lagDays} day(s) past). The prune is capped at 5,000 rows/hour and is not keeping up.`,
    }));

  const status: FeedRetentionLagStatus = tables.some((entry) => entry.status === 'degraded')
    ? 'degraded'
    : tables.some((entry) => entry.status === 'warning')
      ? 'warning'
      : 'ok';

  return { status, tables, issues };
}
