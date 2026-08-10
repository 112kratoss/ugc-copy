import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260810101000_make_feed_retention_probe_constant_cost.sql',
), 'utf8');

describe('feed retention probe migration', () => {
  it('uses exact indexed oldest-row reads without exact full-table counts', () => {
    expect(migration).toContain('ORDER BY ranked_at ASC LIMIT 1');
    expect(migration).toContain('ORDER BY occurred_at ASC LIMIT 1');
    expect(migration).toContain('reltuples');
    expect(migration).not.toMatch(/SELECT count\(\*\) FROM public\.feed_/i);
  });

  it('remains service-role-only', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_feed_retention_lag() FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_feed_retention_lag() TO service_role');
  });
});
