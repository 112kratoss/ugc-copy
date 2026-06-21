import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_restrict_profile_bucket_listing.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('profile storage security migration', () => {
  it('removes public object listing while keeping owner upserts functional', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('DROP POLICY IF EXISTS "Public read access for profiles"');
    expect(migration).toContain('CREATE POLICY "Authenticated users can read own profile media"');
    expect(migration).toMatch(/FOR SELECT TO authenticated/i);
    expect(migration).toMatch(/bucket_id = 'profiles'/i);
    expect(migration).toMatch(/\(SELECT auth\.uid\(\)\)::text/i);
  });

  it('enforces the existing five megabyte client upload limit at storage', () => {
    expect(migration).toMatch(/file_size_limit = 5242880/i);
  });

  it('keeps write and delete policies owner-scoped', () => {
    expect(migration).toContain('CREATE POLICY "Authenticated users can upload own profile media"');
    expect(migration).toContain('CREATE POLICY "Authenticated users can update own profile media"');
    expect(migration).toContain('CREATE POLICY "Authenticated users can delete own profile media"');
    expect(migration.match(/\(SELECT auth\.uid\(\)\)::text/gi)).toHaveLength(5);
  });
});
