import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809190000_prune_feed_clamp_fact_retention.sql',
), 'utf8');

const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'));

describe('prune feed clamp fact retention migration', () => {
  it('clamps the ordering rule instead of raising on it', () => {
    // Raising aborted the whole hourly job — four stats refreshes that have
    // nothing to do with retention — for a configuration disagreement.
    expect(body).toContain('v_fact_retention_days := greatest(p_fact_retention_days, p_event_retention_days)');
    expect(body).not.toContain('OR p_fact_retention_days < p_event_retention_days');
  });

  it('clamps upward, so an automatic correction never deletes more than asked', () => {
    // Over-retention is recoverable; over-deletion is not. `least` here would
    // silently prune events earlier than the caller requested.
    expect(body).toContain('greatest(p_fact_retention_days, p_event_retention_days)');
    expect(body).not.toContain('least(p_fact_retention_days, p_event_retention_days)');
  });

  it('still raises on genuinely invalid input', () => {
    // The clamp resolves a disagreement between two legal values. It is not a
    // licence to accept nonsense.
    expect(body).toContain('Feed fact retention days must be between 1 and 1460');
    expect(body).toContain('OR p_fact_retention_days < 1');
    expect(body).toContain('OR p_fact_retention_days > 1460');
  });

  it('applies the clamped value to the delete, not the raw parameter', () => {
    // The whole change is inert if the body still ages facts off by the
    // unclamped parameter.
    expect(body).toContain('make_interval(days => v_fact_retention_days)');
    expect(body).not.toContain('make_interval(days => p_fact_retention_days)');
  });

  it('records why the guard was reachable at all', () => {
    expect(migration).toMatch(/deadlock/i);
    expect(migration).toMatch(/decision #2/i);
  });
});
