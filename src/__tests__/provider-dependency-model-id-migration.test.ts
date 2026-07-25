import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260725200000_provider_dependency_model_id.sql',
), 'utf8');

describe('provider dependency model id migration', () => {
  it('adds the model attribution column without requiring a value', () => {
    expect(migration).toContain('alter table public.provider_dependency_events');
    expect(migration).toContain('add column if not exists model_id text');
    // Nullable on purpose: provider calls with no generation behind them
    // (payments, FX, push receipts) must be allowed to record no model.
    expect(migration).not.toContain('model_id text not null');
  });

  it('indexes only the attributed rows so non-generation traffic is excluded', () => {
    expect(migration).toContain('provider_dependency_events_model_outcome_created_idx');
    expect(migration).toContain('(model_id, outcome, created_at desc)');
    expect(migration).toContain('where model_id is not null');
  });

  it('records that the column is never backfilled', () => {
    expect(migration).toContain('comment on column public.provider_dependency_events.model_id');
    expect(migration.toLowerCase()).toContain('never backfilled');
  });

  it('is additive only, so replaying it cannot drop existing telemetry', () => {
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/drop\s+column/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from/i);
  });
});
