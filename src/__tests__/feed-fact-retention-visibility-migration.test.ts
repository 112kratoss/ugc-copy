import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809160000_feed_fact_retention_visibility.sql',
), 'utf8');

const previousGrowthMigration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260725140000_operational_table_growth.sql',
), 'utf8');

describe('feed fact retention visibility migration', () => {
  it('adds the fact table that growth reporting was missing', () => {
    // feed_delivery_facts is the table the 5,000 MAU gate is derived from, and
    // it was the one feed table absent from the growth RPC — which already
    // covered feed_events, feed_sessions and feed_session_items.
    expect(previousGrowthMigration).not.toContain("'feed_delivery_facts'");
    expect(previousGrowthMigration).toContain("'feed_events'");
    expect(migration).toContain("'feed_delivery_facts'");
  });

  it('keeps every table the previous growth RPC reported', () => {
    // CREATE OR REPLACE silently narrows the report if a name is dropped, and
    // nothing else would notice a table falling out of monitoring.
    for (const table of [
      'backend_job_runs',
      'backend_rate_limits',
      'generation_completion_jobs',
      'provider_dependency_events',
      'generation_model_provider_checks',
      'feed_events',
      'feed_session_items',
      'feed_sessions',
    ]) {
      expect(migration, `${table} must stay in the growth report`).toContain(`'${table}'`);
    }
  });

  it('measures retention lag from the column each table is actually pruned by', () => {
    // Not interchangeable: feed_events has no `ranked_at`, so the audit's
    // "partition both by ranked_at" cannot be taken literally for it.
    expect(migration).toContain('min(ranked_at) FROM public.feed_delivery_facts');
    expect(migration).toContain('min(occurred_at) FROM public.feed_events');
  });

  it('keeps both functions service-role only', () => {
    for (const fn of ['get_operational_table_growth()', 'get_feed_retention_lag()']) {
      const grants = migration.slice(migration.indexOf(`REVOKE ALL ON FUNCTION public.${fn}`));
      expect(grants).toContain('FROM anon');
      expect(grants).toContain('FROM authenticated');
      expect(grants).toContain('TO service_role');
    }
  });
});
