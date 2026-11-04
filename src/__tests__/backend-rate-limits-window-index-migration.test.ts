import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261104135153_backend_rate_limits_window_index.sql',
);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * pgTAP (backend_rate_limits_window_index.test.sql) pins that the planner can
 * answer the prune and the cost aggregate from the index. This pins the shape:
 * one plain btree in the prune's order, built behind a lock timeout.
 */
describe('the backend rate-limit window index migration', () => {
  const sql = code(readFileSync(MIGRATION_PATH, 'utf8'));

  it('indexes the window in the retention prune\'s order', () => {
    expect(sql).toContain(
      'CREATE INDEX backend_rate_limits_window_start_idx ON public.backend_rate_limits (window_start, scope, subject_key);',
    );
  });

  it('waits at most five seconds for the build\'s lock, in or out of a transaction block', () => {
    // SET LOCAL is a no-op outside a transaction block, which is how
    // `supabase db reset` applies a file; a plain SET, reset after, holds both ways.
    const set = sql.indexOf("SET lock_timeout = '5s';");
    const build = sql.indexOf('CREATE INDEX backend_rate_limits_window_start_idx');
    const reset = sql.indexOf('RESET lock_timeout;');
    expect(set).toBeGreaterThanOrEqual(0);
    expect(set).toBeLessThan(build);
    expect(reset).toBeGreaterThan(build);
    expect(sql).not.toContain('SET LOCAL lock_timeout');
  });

  it('changes nothing else: no function, grant or table rewrite', () => {
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
    expect(sql).not.toMatch(/CONCURRENTLY/i);
  });
});
