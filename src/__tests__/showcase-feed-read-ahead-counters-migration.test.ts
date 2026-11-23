import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261123151805_showcase_feed_read_ahead_counters.sql',
), 'utf8');

describe('showcase feed read-ahead counters migration', () => {
  it('counts each event per UTC hour in one row, incremented in place', () => {
    expect(migration).toContain('PRIMARY KEY (event, bucket_start)');
    expect(migration).toContain("date_trunc('hour', now(), 'UTC')");
    expect(migration).toContain('DO UPDATE SET event_count = counters.event_count + 1');
  });

  it('keeps only the three events the server sends', () => {
    expect(migration).toContain("CHECK (event IN ('hold', 'claim', 'claim_miss'))");
  });

  it('is service-role only, table and function alike', () => {
    expect(migration).toContain('ALTER TABLE public.showcase_feed_read_ahead_counters ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.showcase_feed_read_ahead_counters FROM anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_showcase_feed_read_ahead_event(text) FROM anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.record_showcase_feed_read_ahead_event(text) TO service_role');
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
  });
});
