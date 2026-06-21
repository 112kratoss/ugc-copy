import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs
  .readdirSync(migrationsDir)
  .find((file) => file.endsWith('_backend_rate_limits.sql'));
const migration = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8')
  : '';

describe('backend rate limit migration', () => {
  it('creates a private fixed-window counter table guarded by RLS', () => {
    expect(migrationFile).toBeTruthy();
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.backend_rate_limits');
    expect(migration).toContain('subject_key text NOT NULL');
    expect(migration).toContain('request_count integer NOT NULL DEFAULT 0');
    expect(migration).toContain('PRIMARY KEY (scope, subject_key, window_start)');
    expect(migration).toContain('ALTER TABLE public.backend_rate_limits ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.backend_rate_limits FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_rate_limits TO service_role');
  });

  it('only grants the rate-limit RPC to the service role', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.check_backend_rate_limit');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.check_backend_rate_limit');
    expect(migration).toContain('FROM anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.check_backend_rate_limit');
    expect(migration).toContain('TO service_role');
  });

  it('returns retry metadata and cleans old rows for the same subject', () => {
    expect(migration).toContain('jsonb_build_object');
    expect(migration).toContain("'retryAfterSeconds'");
    expect(migration).toContain('make_interval(secs => v_window_seconds)');
    expect(migration).toContain('DELETE FROM public.backend_rate_limits');
    expect(migration).toContain("window_start < v_window_start - interval '1 day'");
  });
});
