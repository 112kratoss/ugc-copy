import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809180000_feed_delivery_fact_daily.sql',
), 'utf8');

const refreshBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.refresh_feed_delivery_fact_daily'),
);

describe('feed delivery fact daily migration', () => {
  it('uses NULLS NOT DISTINCT, without which the upsert silently never fires', () => {
    // Four of the six grain columns are nullable. Under the default
    // NULLS DISTINCT rule every such row counts as unique, so ON CONFLICT
    // would never match and each hourly refresh would append a duplicate
    // bucket instead of updating one — inflating every metric a little more
    // each hour while looking entirely plausible.
    expect(migration).toContain('UNIQUE NULLS NOT DISTINCT');
    expect(refreshBody).toContain('ON CONFLICT ON CONSTRAINT feed_delivery_fact_daily_grain DO UPDATE');
  });

  it('replaces counts rather than accumulating them', () => {
    // The window is re-read in full on every run, so `deliveries = deliveries +
    // excluded.deliveries` would double-count immediately.
    expect(refreshBody).toContain('deliveries = excluded.deliveries');
    expect(refreshBody).not.toMatch(/deliveries\s*=\s*target\.deliveries\s*\+/);
  });

  it('recomputes a trailing window, because facts are mutated after insert', () => {
    // served_at, opened_at, saved_at and the rest are stamped as outcomes
    // arrive, so a day's bucket is not final when the day ends.
    expect(refreshBody).toContain('p_lookback_days');
    expect(refreshBody).toContain('make_interval(days => v_lookback)');
  });

  it('counts observations on > 0, not on IS NOT NULL', () => {
    // dwell_ms_max and media_progress_max are NOT NULL DEFAULT 0, so a null
    // check counts every delivery as an observation and divides by the wrong
    // denominator — an average that stays plausible while being wrong.
    expect(refreshBody).toContain('FILTER (WHERE facts.dwell_ms_max > 0)');
    expect(refreshBody).toContain('FILTER (WHERE facts.media_progress_max > 0)');
    expect(refreshBody).not.toContain('facts.dwell_ms_max IS NOT NULL');
  });

  it('stores sums beside counts so buckets stay re-aggregatable', () => {
    // An average cannot be re-aggregated across buckets, and every question at
    // this grain is asked by summing several of them.
    for (const column of ['dwell_ms_sum', 'dwell_ms_count', 'media_progress_sum', 'media_progress_count']) {
      expect(migration).toContain(column);
    }
    expect(migration).not.toContain('dwell_ms_avg');
  });

  it('outlives the raw fact window it exists to replace', () => {
    // Decision #2 cut raw facts to 30 days *because* these carry the lookback.
    // A shorter aggregate window would make that trade a straight loss.
    expect(refreshBody).toContain('p_retention_days integer DEFAULT 400');
  });

  it('keeps the table and function service-role only', () => {
    expect(migration).toContain('ALTER TABLE public.feed_delivery_fact_daily ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.feed_delivery_fact_daily FROM anon, authenticated');
    const grants = migration.slice(migration.indexOf('REVOKE ALL ON FUNCTION public.refresh_feed_delivery_fact_daily'));
    expect(grants).toContain('FROM authenticated');
    expect(grants).toContain('TO service_role');
  });
});
