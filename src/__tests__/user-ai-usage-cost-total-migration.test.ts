import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260729090100_user_ai_usage_cost_total.sql',
), 'utf8');

describe('user ai usage cost total migration', () => {
  it('aggregates in the database rather than returning rows to be summed', () => {
    // The console previously selected up to 10,000 rows and summed them in JS,
    // so the figure was silently wrong past the cap.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_user_ai_usage_cost_total(');
    expect(migration).toContain('sum(usage.cost)');
    expect(migration).not.toMatch(/\blimit\b/i);
  });

  it('excludes refunded events from spend', () => {
    expect(migration).toContain('FILTER (WHERE usage.refunded IS NOT TRUE)');
    expect(migration).toContain("'refunded_count'");
  });

  it('is a read-only aggregate scoped to one user', () => {
    expect(migration).toContain('STABLE');
    expect(migration).toContain('WHERE usage.user_id = p_user_id');
  });

  it('keeps the aggregate restricted to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.get_user_ai_usage_cost_total(uuid)\n  FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_user_ai_usage_cost_total(uuid)\n  TO service_role',
    );
    expect(migration).toContain('SET search_path = public, pg_temp');
  });
});
