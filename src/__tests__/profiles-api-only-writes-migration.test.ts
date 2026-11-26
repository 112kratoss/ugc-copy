import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security audit, 2026-11-26: an account could PATCH its own `profiles` row
 * through PostgREST, past the reserved handles and every other rule
 * `validateProfileUpdate` holds a save to. The API writes with the service
 * role, so the client grant was unused; this migration takes it away.
 */
const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs
  .readdirSync(migrationsDir)
  .find((file) => file.endsWith('_profiles_are_written_by_the_api_only.sql'));
const migration = migrationFile ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8') : '';
const statements = migration.replace(/--.*$/gm, '').replace(/\s+/g, ' ');

const CLIENT_WRITABLE_BEFORE = [
  'username', 'display_name', 'bio', 'avatar_url', 'cover_url', 'website_url',
  'twitter_handle', 'instagram_handle', 'tiktok_handle', 'location',
];

describe('profiles are written by the API only', () => {
  it('revokes every column the Data API roles could update', () => {
    expect(migrationFile).toBeTruthy();
    const revoke = statements.match(/REVOKE UPDATE \(([^)]+)\) ON TABLE public\.profiles FROM authenticated, anon;/);
    expect(revoke).not.toBeNull();
    const columns = revoke![1].split(',').map((column) => column.trim());
    expect([...columns].sort()).toEqual([...CLIENT_WRITABLE_BEFORE].sort());
  });

  it('names the same columns the earlier grant gave', () => {
    const grantFile = fs.readdirSync(migrationsDir).find((file) => file.endsWith('_restrict_profile_credit_updates.sql'));
    const grant = fs.readFileSync(path.join(migrationsDir, grantFile!), 'utf8')
      .match(/GRANT UPDATE \(([^)]+)\) ON TABLE public\.profiles TO authenticated/);
    expect(grant![1].split(',').map((column) => column.trim()).sort()).toEqual([...CLIENT_WRITABLE_BEFORE].sort());
  });

  it('leaves no table-level write and grants nothing back', () => {
    expect(statements).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.profiles FROM authenticated, anon;');
    expect(statements).not.toMatch(/\bGRANT\b/);
  });

  it('is the last word on profile grants', () => {
    const later = fs.readdirSync(migrationsDir)
      .filter((file) => file > migrationFile!)
      .filter((file) => /GRANT[^;]*\bUPDATE\b[^;]*ON (TABLE )?public\.profiles TO[^;]*(authenticated|anon)/i
        .test(fs.readFileSync(path.join(migrationsDir, file), 'utf8')));
    expect(later).toEqual([]);
  });

  it('keeps the API on the service role, which the revoke does not touch', () => {
    const adapter = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/profile-route-adapter-service.ts'), 'utf8');
    // Every profile service call is handed the service client factory, never the caller's.
    expect(adapter.match(/client: resolvedDependencies\.createServiceClient/g)?.length).toBeGreaterThanOrEqual(2);
    expect(adapter).not.toMatch(/client: .*createUserClient/);
  });
});
