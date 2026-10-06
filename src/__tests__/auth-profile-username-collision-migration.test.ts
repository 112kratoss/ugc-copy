import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(), 'supabase/migrations/20261006203443_auth_profile_username_collision.sql',
), 'utf8');

describe('signup placeholder collision migration', () => {
  it('keeps the trigger privileged with a fixed search path', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;');
  });

  it('uses the case-insensitive index and bounds compatible placeholder retries', () => {
    expect(migration).toContain('ON CONFLICT (lower(username)) WHERE username IS NOT NULL DO NOTHING');
    expect(migration).toContain('FOR attempt IN 1..32 LOOP');
    expect(migration).toContain("'creator-' || left(pg_catalog.gen_random_uuid()::text, 8)");
    expect(migration).toContain('VALUES (new.id, 0, candidate_username)');
    expect(migration).not.toMatch(/DO UPDATE|UPDATE public\.profiles|CREATE UNIQUE INDEX/i);
  });
});
