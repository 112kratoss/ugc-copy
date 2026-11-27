import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261127060200_generation_terminal_states.sql', 'utf8');

function enqueueBody(): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.enqueue_generation_output_import_job(');
  const end = sql.indexOf('$function$;', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, end);
}

describe('generation terminal states migration', () => {
  it('adds the reaper rotation column without a table-wide index build', () => {
    expect(sql).toMatch(/ALTER TABLE public\.generations\s+ADD COLUMN IF NOT EXISTS provider_sync_attempted_at timestamptz;/);
    expect(sql).not.toMatch(/CREATE INDEX[^;]*ON public\.generations/);
  });

  it('keeps an exhausted import failed when a status check enqueues it again', () => {
    const body = enqueueBody();
    // Both the status and its clock stay put for processing, succeeded and failed jobs.
    expect(body.match(/status IN \('processing', 'succeeded', 'failed'\)/g)).toHaveLength(2);
    // The URLs are still refreshed for everything but a finished import.
    expect(body).toContain("WHEN public.generation_output_import_jobs.status = 'succeeded'\n        THEN public.generation_output_import_jobs.output_urls");
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.enqueue_generation_output_import_job(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.enqueue_generation_output_import_job(uuid, jsonb, timestamptz) TO service_role;');
  });

  it('records payment capture anomalies once per payment and reason, service-only and append-only', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.payment_capture_anomalies');
    expect(sql).toContain('UNIQUE (provider, payment_id, reason)');
    expect(sql).toContain('ALTER TABLE public.payment_capture_anomalies ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON public.payment_capture_anomalies FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT SELECT, INSERT ON public.payment_capture_anomalies TO service_role;');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON public.payment_capture_anomalies FROM service_role;');
    expect(sql).not.toMatch(/TO authenticated|TO anon/);
  });
});
