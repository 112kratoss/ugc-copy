/**
 * Operational table growth reporting.
 *
 * Surfaces row counts and byte sizes for churn-prone operational state,
 * user-owned workflow history, and permanent security ledgers, so growth is
 * visible in the protected ops dashboard before it becomes a cost or latency
 * problem.
 *
 * Thresholds are per-table and deliberately generous: these tables are expected
 * to grow, and the signal that matters is growth the retention sweep is not
 * keeping up with.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type OperationalTableGrowthRow = {
  tableName: string;
  liveRows: number;
  totalBytes: number;
};

export type OperationalTableGrowthSeverity = 'ok' | 'warning' | 'degraded';

export type OperationalTableGrowthIssue = {
  severity: Exclude<OperationalTableGrowthSeverity, 'ok'>;
  code: 'OPERATIONAL_TABLE_GROWTH_ELEVATED' | 'OPERATIONAL_TABLE_GROWTH_SPIKE';
  tableName: string;
  message: string;
};

export type OperationalTableGrowthReport = {
  status: OperationalTableGrowthSeverity;
  tables: OperationalTableGrowthRow[];
  totalBytes: number;
  issues: OperationalTableGrowthIssue[];
};

/**
 * Policy-specific growth guardrails. Crossing one can mean retention lag for a
 * pruned table or a capacity/planning threshold for user history and permanent
 * ledgers; it is not itself proof of which cause applies.
 */
export const OPERATIONAL_TABLE_ROW_BUDGETS: Record<string, { warning: number; degraded: number }> = {
  backend_job_runs: { warning: 40_000, degraded: 150_000 },
  backend_rate_limits: { warning: 20_000, degraded: 100_000 },
  generation_completion_jobs: { warning: 10_000, degraded: 50_000 },
  provider_dependency_events: { warning: 50_000, degraded: 200_000 },
  generation_model_provider_checks: { warning: 20_000, degraded: 100_000 },
  feed_events: { warning: 200_000, degraded: 1_000_000 },
  feed_session_items: { warning: 200_000, degraded: 1_000_000 },
  feed_sessions: { warning: 50_000, degraded: 250_000 },
  // F7b. Deliberately generous, and deliberately not the primary signal: at a
  // 30-day window this table's steady state is ~37k rows at today's traffic and
  // ~1.8M at 5,000 MAU, so any fixed row ceiling either fires constantly at
  // scale or never fires at all. It is a backstop against runaway growth;
  // `feed-retention-lag.ts` is what actually detects a prune falling behind,
  // because lag reads 0 at any size while the sweep keeps up.
  feed_delivery_facts: { warning: 3_000_000, degraded: 8_000_000 },
  workflow_run_step_jobs: { warning: 10_000, degraded: 50_000 },
  upload_byte_reservations: { warning: 50_000, degraded: 200_000 },
  upload_byte_user_counters: { warning: 100_000, degraded: 500_000 },
  upload_path_tombstones: { warning: 1_000_000, degraded: 5_000_000 },
  account_merge_tickets: { warning: 100_000, degraded: 500_000 },
  workflow_canvas_runs: { warning: 100_000, degraded: 500_000 },
  workflow_canvas_run_steps: { warning: 500_000, degraded: 2_000_000 },
  template_runs: { warning: 100_000, degraded: 500_000 },
  template_run_steps: { warning: 500_000, degraded: 2_000_000 },
  // Usage audit, 2026-11-04: the blind spots. Each is a backstop against
  // runaway growth, sized well above its steady state at today's traffic.
  // A viewer-day row per viewer, kept 400 days.
  feed_viewer_daily: { warning: 1_000_000, degraded: 4_000_000 },
  // Kept for good: the accounting never goes; text is cleared after 90 days.
  ai_usage_events: { warning: 500_000, degraded: 2_000_000 },
  // Read alerts go after 180 days, unread ones after 365.
  mobile_notifications: { warning: 500_000, degraded: 2_000_000 },
  mobile_push_deliveries: { warning: 200_000, degraded: 1_000_000 },
  // Up to four rows per app flush, kept 90 days.
  playback_metrics: { warning: 200_000, degraded: 1_000_000 },
  onboarding_events: { warning: 500_000, degraded: 2_000_000 },
  // Expired locks go after a day, so this holds about a day of polling.
  backend_job_locks: { warning: 20_000, degraded: 100_000 },
  // Every identity, registered or guest; Pro includes 100,000 MAU.
  'auth.users': { warning: 100_000, degraded: 500_000 },
  // Live anonymous users: idle ones are deleted after 90 days, or 180 days
  // with content, so a climb here means guests are not being retired.
  guest_identities: { warning: 50_000, degraded: 250_000 },
  // The MCP server's audit ledger: one row per agent tool call, polls included, kept for
  // good until a pruning migration (the runbook's retention follow-up). A backstop against a
  // runaway agent, sized far above any steady state today.
  agent_tool_calls: { warning: 200_000, degraded: 1_000_000 },
  // The anonymous search log: one row per first-page search answer, kept 90 days. A backstop
  // against a runaway client, not a traffic measure: typing steps log one row each.
  search_query_events: { warning: 500_000, degraded: 2_000_000 },
  // Search by meaning. A vector per searchable post with words of its own, read whole on every
  // related-posts lookup (about 1 ms per 5,000): the warning is where that read nears 50 ms and
  // an index-backed one is worth designing (migration 20261112215420), not a retention lag.
  post_search_embeddings: { warning: 250_000, degraded: 1_000_000 },
  // The cache of query vectors: 2,000 new queries a day at most, kept 7 days, so 14,000 rows at
  // the code's cap and 35,000 at the database's ceiling. Past the warning the cap or the prune
  // is not holding.
  search_query_embeddings: { warning: 20_000, degraded: 40_000 },
};

const DEFAULT_BUDGET = { warning: 100_000, degraded: 500_000 };

function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeOperationalTableGrowthRows(data: unknown): OperationalTableGrowthRow[] {
  if (!Array.isArray(data)) return [];

  return data.flatMap((row) => {
    if (!isRecord(row)) return [];
    const tableName = typeof row.table_name === 'string' ? row.table_name : null;
    if (!tableName) return [];
    // bigint columns arrive as strings over PostgREST.
    return [{
      tableName,
      liveRows: toCount(row.live_rows),
      totalBytes: toCount(row.total_bytes),
    }];
  });
}

export function evaluateOperationalTableGrowth(
  tables: OperationalTableGrowthRow[],
): OperationalTableGrowthReport {
  const issues: OperationalTableGrowthIssue[] = [];

  for (const table of tables) {
    const budget = OPERATIONAL_TABLE_ROW_BUDGETS[table.tableName] ?? DEFAULT_BUDGET;

    if (table.liveRows >= budget.degraded) {
      issues.push({
        severity: 'degraded',
        code: 'OPERATIONAL_TABLE_GROWTH_SPIKE',
        tableName: table.tableName,
        message: `${table.tableName} holds ${table.liveRows} rows, at or above the ${budget.degraded} degraded growth budget. Inspect its retention or capacity policy.`,
      });
      continue;
    }

    if (table.liveRows >= budget.warning) {
      issues.push({
        severity: 'warning',
        code: 'OPERATIONAL_TABLE_GROWTH_ELEVATED',
        tableName: table.tableName,
        message: `${table.tableName} holds ${table.liveRows} rows, at or above the ${budget.warning} warning budget.`,
      });
    }
  }

  const status: OperationalTableGrowthSeverity = issues.some((issue) => issue.severity === 'degraded')
    ? 'degraded'
    : issues.length > 0
      ? 'warning'
      : 'ok';

  return {
    status,
    tables,
    totalBytes: tables.reduce((total, table) => total + table.totalBytes, 0),
    issues,
  };
}

export async function collectOperationalTableGrowth(
  client: Pick<SupabaseClient, 'rpc'>,
): Promise<OperationalTableGrowthReport> {
  const { data, error } = await client.rpc('get_operational_table_growth', {});
  if (error) throw error;

  return evaluateOperationalTableGrowth(normalizeOperationalTableGrowthRows(data));
}
