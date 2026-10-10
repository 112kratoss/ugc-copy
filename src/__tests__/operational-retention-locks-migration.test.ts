import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync('supabase/migrations/20261010071057_skip_locked_operational_retention.sql', 'utf8');
describe('operational retention lock-progress migration', () => {
  it('preserves the service-only security boundary and existing cap default', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('p_max_deletes_per_table integer DEFAULT 5000');
    for (const role of ['PUBLIC', 'anon', 'authenticated']) expect(migration).toContain(`FROM ${role};`);
    expect(migration).toContain('TO service_role;');
  });
  it('locks base-table victims for all five phases without locking the DISTINCT catalog query', () => {
    expect(migration.match(/FOR UPDATE(?: OF checks)? SKIP LOCKED/g)).toHaveLength(5);
    const latest = migration.slice(migration.indexOf('WITH latest_per_model'), migration.indexOf('  prunable AS (', migration.indexOf('WITH latest_per_model')));
    expect(latest).toContain('DISTINCT ON (model_id)');
    expect(latest).not.toContain('FOR UPDATE');
    expect(migration).toContain('FOR UPDATE OF checks SKIP LOCKED');
  });
});
