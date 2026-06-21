import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.join(process.cwd(), 'supabase/migrations');

describe('AI usage health indexes migration', () => {
  it('adds indexes for recent spend and stale pending health queries', () => {
    const migrationFile = readdirSync(migrationsDir)
      .find((file) => file.endsWith('_optimize_ai_usage_health_indexes.sql'));

    expect(migrationFile).toBeDefined();

    const migration = readFileSync(path.join(migrationsDir, migrationFile!), 'utf8');

    expect(migration).toContain('CREATE INDEX IF NOT EXISTS ai_usage_events_created_at_idx');
    expect(migration).toContain('ON public.ai_usage_events (created_at DESC)');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS ai_usage_events_pending_created_at_idx');
    expect(migration).toContain("WHERE status = 'pending'");
  });
});
