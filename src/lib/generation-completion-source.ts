import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * How generation completions are actually finishing: inline on the
 * post-webhook drain, or on the 10-minute cron sweep.
 *
 * This is the measurement the durable-queue decision depends on. The inline
 * drain runs immediately after the provider callback and is the fast path; the
 * cron sweep is the safety net that catches whatever the drain missed. If
 * nearly everything settles inline, the single-lock cron design has plenty of
 * headroom and a durable queue would be premature. If the sweep's share is
 * climbing, the drain is failing to keep up and the queue question becomes
 * real — but *which* it is cannot be argued from intuition, only measured.
 */
export type GenerationCompletionSourceBreakdown = {
  windowHours: number;
  /** Terminal jobs in the window that carry an attribution. */
  attributed: number;
  /**
   * Terminal jobs with no attribution. These are jobs completed before the
   * `completed_via` column existed; they are counted separately rather than
   * folded into either runner, so an old backlog cannot skew the ratio.
   */
  unattributed: number;
  webhookDrain: number;
  cronSweep: number;
  /**
   * Inline drain share of attributed completions, 0–1, or null when nothing
   * has been attributed yet. Null rather than 0: "no data" and "the drain
   * handled none of them" are very different signals for this decision.
   */
  webhookDrainShare: number | null;
};

export const GENERATION_COMPLETION_SOURCE_WINDOW_HOURS = 24;

type CompletionSourceRow = {
  completed_via: string | null;
};

export function summarizeGenerationCompletionSources(
  rows: CompletionSourceRow[],
  windowHours = GENERATION_COMPLETION_SOURCE_WINDOW_HOURS,
): GenerationCompletionSourceBreakdown {
  let webhookDrain = 0;
  let cronSweep = 0;
  let unattributed = 0;

  for (const row of rows) {
    if (row.completed_via === 'webhook_drain') webhookDrain += 1;
    else if (row.completed_via === 'cron_sweep') cronSweep += 1;
    else unattributed += 1;
  }

  const attributed = webhookDrain + cronSweep;

  return {
    windowHours,
    attributed,
    unattributed,
    webhookDrain,
    cronSweep,
    webhookDrainShare: attributed > 0 ? webhookDrain / attributed : null,
  };
}

export async function collectGenerationCompletionSources(
  client: SupabaseClient,
  now = new Date(),
  windowHours = GENERATION_COMPLETION_SOURCE_WINDOW_HOURS,
): Promise<GenerationCompletionSourceBreakdown> {
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();

  // Fail soft on both shapes of failure: a returned error (a database that
  // predates the column) and a throw (a client that cannot build this query at
  // all). This is a reporting surface — it must never be the reason the whole
  // cost report fails.
  try {
    const { data, error } = await client
      .from('generation_completion_jobs')
      .select('completed_via')
      .not('completed_at', 'is', null)
      .gte('completed_at', since)
      .limit(1000);

    if (error || !Array.isArray(data)) {
      return summarizeGenerationCompletionSources([], windowHours);
    }

    return summarizeGenerationCompletionSources(data as CompletionSourceRow[], windowHours);
  } catch {
    return summarizeGenerationCompletionSources([], windowHours);
  }
}
