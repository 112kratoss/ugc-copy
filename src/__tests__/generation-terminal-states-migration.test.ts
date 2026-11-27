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

  it('reopens an exhausted import only for a different file address, five minutes after its last failure, without resetting its tries', () => {
    const body = enqueueBody();
    // Query strings (a per-request signature or expiry) are dropped before comparing.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.generation_output_import_url_paths(p_urls jsonb)');
    expect(sql).toContain("regexp_replace(item.value #>> '{}', '[?#].*$', '')");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.generation_output_import_url_paths(jsonb) FROM PUBLIC, anon, authenticated;');
    const reopen = [
      "public.generation_output_import_jobs.status = 'failed'",
      "AND public.generation_output_import_jobs.completed_at <= now() - interval '5 minutes'",
      'AND public.generation_output_import_url_paths(public.generation_output_import_jobs.output_urls)',
      'IS DISTINCT FROM public.generation_output_import_url_paths(excluded.output_urls)',
    ];
    for (const line of reopen) expect(body.split(line).length - 1).toBe(2);
    // The raw URLs are never what decides a reopen.
    expect(body).not.toContain('output_urls IS DISTINCT FROM excluded.output_urls');
    // The freshest URLs are stored for every unfinished job, failed included.
    expect(body).toContain("WHEN public.generation_output_import_jobs.status = 'succeeded'\n        THEN public.generation_output_import_jobs.output_urls\n      ELSE excluded.output_urls");
    expect(body).not.toMatch(/attempt_count/);
  });

  it('counts an expired lease as an attempt, so an import killed mid-run exhausts instead of looping', () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_generation_output_import_jobs(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, sql.indexOf('$function$;', start));
    // The crash that uses the last try marks the job failed rather than handing it out again.
    expect(body).toMatch(/SET status = 'failed', attempt_count = attempt_count \+ 1/);
    expect(body).toContain('attempt_count + 1 >= 10');
    // Any other reclaim of an expired lease adds one.
    expect(body).toContain("attempt_count = jobs.attempt_count + CASE WHEN jobs.status = 'processing' THEN 1 ELSE 0 END");
    expect(body).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.claim_generation_output_import_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.claim_generation_output_import_jobs(integer, text, integer) TO service_role;');
  });

  it('keeps the claim limit in step with the TypeScript attempt ceiling', async () => {
    const { GENERATION_OUTPUT_IMPORT_MAX_ATTEMPTS } = await import('@/lib/generation-output-import-jobs');
    expect(sql).toContain(`attempt_count + 1 >= ${GENERATION_OUTPUT_IMPORT_MAX_ATTEMPTS}`);
  });

  it('records payment capture anomalies once per payment and reason, service-only and append-only', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.payment_capture_anomalies');
    expect(sql).toContain('UNIQUE (provider, payment_id, reason)');
    // A capture that matched no order has no kind to name.
    expect(sql).toContain("purchase_kind IN ('credits', 'marketplace', 'post_resource', 'unknown')");
    expect(sql).toContain('ALTER TABLE public.payment_capture_anomalies ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON public.payment_capture_anomalies FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT SELECT, INSERT ON public.payment_capture_anomalies TO service_role;');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON public.payment_capture_anomalies FROM service_role;');
    expect(sql).not.toMatch(/TO authenticated|TO anon/);
  });
});
