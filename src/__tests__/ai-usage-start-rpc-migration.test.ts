import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationNames = fs.readdirSync(migrationsDirectory)
  .filter((name) => name.includes('ai_usage_start') || name.endsWith('_atomic_ai_usage_start.sql'))
  .sort();
const migration = migrationNames
  .map((name) => fs.readFileSync(path.join(migrationsDirectory, name), 'utf8'))
  .join('\n');

describe('atomic AI usage start migration', () => {
  it('starts paid AI ledger reservations in one database transaction', () => {
    expect(migrationNames.length).toBeGreaterThan(0);
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.start_ai_usage_event');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('UPDATE public.profiles');
    expect(migration).toContain('INSERT INTO public.ai_usage_events');
    expect(migration).toContain('p_cost IS NULL');
    expect(migration).toContain("'started'");
    expect(migration).toContain("'succeeded_replay'");
    expect(migration).toContain("'in_progress'");
  });

  it('keeps the AI usage start RPC private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) FROM anon');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) TO service_role');
  });
});
