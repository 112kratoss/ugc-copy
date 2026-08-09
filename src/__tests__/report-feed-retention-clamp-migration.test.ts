import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809230000_report_feed_retention_clamp.sql',
), 'utf8');

describe('report feed retention clamp migration', () => {
  it('recreates the prune function rather than a new one', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.prune_feed_personalization_data(',
    );
  });

  it('keeps the upward clamp exactly as the incident fix defined it', () => {
    expect(migration).toContain(
      'v_fact_retention_days := greatest(p_fact_retention_days, p_event_retention_days);',
    );
  });

  it('reports the clamp in the summary instead of applying it silently', () => {
    expect(migration).toContain("'fact_retention_days_requested', p_fact_retention_days,");
    expect(migration).toContain("'fact_retention_days_applied', v_fact_retention_days,");
    expect(migration).toContain(
      "'fact_retention_clamped', v_fact_retention_days <> p_fact_retention_days",
    );
  });

  it('still rejects genuinely invalid input', () => {
    expect(migration).toContain(
      "RAISE EXCEPTION 'Feed fact retention days must be between 1 and 1460';",
    );
  });
});
