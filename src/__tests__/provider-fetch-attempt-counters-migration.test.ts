import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260808153000_provider_fetch_attempt_counters.sql',
), 'utf8');

describe('provider fetch attempt counters migration', () => {
  it('buckets by service and hour with an in-place increment', () => {
    // A counter, not a row per call: the audit's F15a explicitly forbids
    // persisting a success row per attempt.
    expect(migration).toContain('PRIMARY KEY (service_name, bucket_start)');
    expect(migration).toContain("date_trunc('hour', timezone('utc', now()))");
    expect(migration).toContain('DO UPDATE SET attempt_count = counters.attempt_count + 1');
  });

  it('never records an unnamed service as an empty key', () => {
    expect(migration).toContain("coalesce(nullif(btrim(p_service_name), ''), 'unknown')");
  });

  it('is service-role only, table and function alike', () => {
    expect(migration).toContain('ALTER TABLE public.provider_fetch_attempt_counters ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.provider_fetch_attempt_counters FROM anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.record_provider_fetch_attempt(text) TO service_role');
    expect(migration).toContain('SET search_path = public, pg_temp');
  });
});
