import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261104135403_operational_retention_covers_unbounded_tables.sql',
);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * pgTAP (operational_retention_unbounded_tables.test.sql) asserts what each new
 * phase deletes, clears and keeps. This pins the shape the job and the
 * deployment depend on: one signature, the old parameters first and unchanged,
 * every new window a default, bounded skip-locked batches, and a playback
 * rollup written before any raw day can go.
 */
describe('the operational retention migration for the unbounded tables', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const all = code(sql);
  const fn = code(sql.slice(
    sql.indexOf('CREATE FUNCTION public.prune_operational_backend_data('),
    sql.indexOf('REVOKE ALL ON FUNCTION public.prune_operational_backend_data('),
  ));

  it('replaces the eight-parameter function with one that takes the old parameters first', () => {
    expect(all).toContain(
      'DROP FUNCTION IF EXISTS public.prune_operational_backend_data( timestamptz, integer, integer, integer, integer, integer, integer, integer );',
    );
    expect(fn).toContain([
      'CREATE FUNCTION public.prune_operational_backend_data(',
      'p_now timestamptz DEFAULT now(),',
      'p_job_run_retention_days integer DEFAULT 30,',
      'p_skipped_job_run_retention_days integer DEFAULT 7,',
      'p_rate_limit_retention_days integer DEFAULT 2,',
      'p_completion_job_retention_days integer DEFAULT 14,',
      'p_provider_event_retention_days integer DEFAULT 30,',
      'p_provider_check_retention_days integer DEFAULT 60,',
      'p_max_deletes_per_table integer DEFAULT 5000,',
      'p_playback_metric_retention_days integer DEFAULT 90,',
      'p_onboarding_event_retention_days integer DEFAULT 365,',
      'p_ai_usage_payload_retention_days integer DEFAULT 90,',
      'p_unread_notification_retention_days integer DEFAULT 365,',
      'p_expired_job_lock_retention_days integer DEFAULT 1 )',
    ].join(' '));
    expect(fn).toContain('SECURITY DEFINER SET search_path = public, pg_temp');
  });

  it('keeps the function service-role only', () => {
    const signature = 'timestamptz, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer';
    expect(all).toContain(`REVOKE ALL ON FUNCTION public.prune_operational_backend_data( ${signature} ) FROM PUBLIC, anon, authenticated;`);
    expect(all).toContain(`GRANT EXECUTE ON FUNCTION public.prune_operational_backend_data( ${signature} ) TO service_role;`);
  });

  it('runs every new phase as a bounded batch that skips rows a writer holds', () => {
    for (const phase of [
      'FROM public.playback_metrics AS m WHERE m.received_at < v_today - make_interval(days => p_playback_metric_retention_days)',
      'FROM public.onboarding_events WHERE created_at < v_now - make_interval(days => p_onboarding_event_retention_days)',
      "FROM public.ai_usage_events WHERE status IN ('succeeded', 'failed', 'refunded') AND created_at < v_now - make_interval(days => p_ai_usage_payload_retention_days)",
      'FROM public.mobile_notifications WHERE is_read = false AND updated_at < v_now - make_interval(days => p_unread_notification_retention_days)',
      'FROM public.backend_job_locks WHERE locked_until < v_now - make_interval(days => p_expired_job_lock_retention_days)',
    ]) {
      const start = fn.indexOf(phase);
      expect(start, phase).toBeGreaterThanOrEqual(0);
      const batch = fn.slice(start, fn.indexOf(')', fn.indexOf('SKIP LOCKED', start)));
      expect(batch, phase).toContain('LIMIT v_max_deletes');
      expect(batch, phase).toMatch(/FOR UPDATE (OF m )?SKIP LOCKED/);
    }
  });

  it('clears only the three payload columns of a settled AI usage event', () => {
    expect(fn).toContain('UPDATE public.ai_usage_events AS events SET input_prompt = NULL, output_text = NULL, response_payload = NULL FROM clearable');
    const update = fn.slice(fn.indexOf('UPDATE public.ai_usage_events'), fn.indexOf('GET DIAGNOSTICS v_ai_usage_payloads_cleared'));
    for (const accounting of ['cost', 'status', 'refunded', 'settled_at', 'promotional_credits_used', 'client_request_key_hash']) {
      expect(update).not.toMatch(new RegExp(`\\b${accounting}\\s*=`));
    }
  });

  it('runs every phase on the database\'s clock when a caller\'s is ahead', () => {
    expect(fn).toContain('v_now timestamptz := least(coalesce(p_now, now()), now());');
    expect(fn).toContain("v_today timestamptz := date_trunc('day', least(coalesce(p_now, now()), now()), 'UTC');");
    // No phase reads the caller's clock directly.
    const body = fn.slice(fn.indexOf('BEGIN'));
    expect(body).not.toMatch(/\bp_now\b/);
  });

  it('rolls a finished playback day up before any of its raw rows may be deleted', () => {
    const rollup = fn.indexOf('INSERT INTO public.playback_metrics_daily_rollup');
    const prune = fn.indexOf('DELETE FROM public.playback_metrics AS metrics');
    expect(rollup).toBeGreaterThan(0);
    expect(prune).toBeGreaterThan(rollup);
    expect(fn).toContain('WHERE m.received_at < v_today AND NOT EXISTS ( SELECT 1 FROM public.playback_metrics_daily_rollup AS rollup');
    expect(fn).toContain('ON CONFLICT (day, platform, network, surface, start_kind) DO NOTHING');
    expect(fn.slice(prune - 600, prune)).toContain(
      "AND EXISTS ( SELECT 1 FROM public.playback_metrics_daily_rollup AS rollup WHERE rollup.day = date_trunc('day', m.received_at, 'UTC') )",
    );
  });

  it('keeps the playback view\'s columns and reads the rollup for the days it holds', () => {
    const view = code(sql.slice(
      sql.indexOf('CREATE OR REPLACE VIEW public.playback_metrics_daily'),
      sql.indexOf('REVOKE ALL ON public.playback_metrics_daily'),
    ));
    expect(view).toContain('WITH (security_invoker = true)');
    expect(view).toContain('FROM public.playback_metrics_daily_rollup AS rollup UNION ALL');
    expect(view).toContain("WHERE NOT EXISTS ( SELECT 1 FROM rolled_up_days WHERE rolled_up_days.day = date_trunc('day', m.received_at, 'UTC') )");
    for (const column of [
      'AS start_mean_ms', 'AS stalls_per_start', 'rollup.start_p50_ms', 'rollup.start_p95_ms', 'rollup.stall_max_ms',
    ]) {
      expect(view).toContain(column);
    }
    expect(all).toContain('GRANT SELECT ON public.playback_metrics_daily TO service_role;');
  });

  it('gives the rollup table service-role reads only, with row level security on', () => {
    expect(all).toContain('ALTER TABLE public.playback_metrics_daily_rollup ENABLE ROW LEVEL SECURITY;');
    expect(all).toContain('REVOKE ALL PRIVILEGES ON TABLE public.playback_metrics_daily_rollup FROM PUBLIC, anon, authenticated, service_role;');
    expect(all).toContain('GRANT SELECT ON TABLE public.playback_metrics_daily_rollup TO service_role;');
  });

  it('indexes only what the new phases act on, behind a lock timeout', () => {
    const timeout = all.indexOf("SET lock_timeout = '5s';");
    const reset = all.indexOf('RESET lock_timeout;');
    expect(timeout).toBeGreaterThan(0);
    for (const index of [
      'CREATE INDEX mobile_notifications_unread_retention_idx ON public.mobile_notifications (updated_at, id) WHERE is_read = false;',
      'CREATE INDEX ai_usage_events_payload_retention_idx ON public.ai_usage_events (created_at, id) WHERE input_prompt IS NOT NULL OR output_text IS NOT NULL OR response_payload IS NOT NULL;',
    ]) {
      expect(all.indexOf(index)).toBeGreaterThan(timeout);
      expect(all.indexOf(index)).toBeLessThan(reset);
    }
    expect(all).not.toContain('SET LOCAL lock_timeout');
    // A lock renewal keeps its heap-only update: nothing indexes locked_until.
    expect(all).not.toMatch(/CREATE INDEX [a-z_]+ ON public\.backend_job_locks/);
  });

  it('reports each phase and counts a full batch of any of them as more to do', () => {
    for (const key of [
      'playback_days_rolled_up', 'playback_metrics_deleted', 'onboarding_events_deleted',
      'ai_usage_payloads_cleared', 'unread_notifications_deleted', 'expired_job_locks_deleted',
    ]) {
      expect(fn).toContain(`'${key}',`);
    }
    for (const count of [
      'v_playback_metrics_deleted', 'v_onboarding_events_deleted', 'v_ai_usage_payloads_cleared',
      'v_unread_notifications_deleted', 'v_expired_job_locks_deleted',
    ]) {
      expect(fn).toContain(`OR ${count} >= v_max_deletes`);
    }
  });
});
