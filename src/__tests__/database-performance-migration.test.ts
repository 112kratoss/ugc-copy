import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_optimize_rls_and_foreign_key_indexes.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('database performance migration', () => {
  it('adds every advisor-requested foreign-key index', () => {
    expect(migrationName).toBeDefined();
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/gi)).toHaveLength(23);
    expect(migration).toContain('ON public.ai_usage_events (user_id)');
    expect(migration).toContain('ON public.generation_input_media (source_generation_id)');
    expect(migration).toContain('ON public.workflow_canvas_runs (user_id)');
  });

  it('evaluates auth identity once for advisor and storage policies', () => {
    expect(migration).toContain("replace(policy_record.qual, 'auth.uid()', '(select auth.uid())')");
    expect(migration).toContain("('public', 'generation_input_media', 'Users can update own generation input media')");
    expect(migration).toContain("('storage', 'objects', 'Users can update own generation inputs')");
  });

  it('uses role targeting instead of the legacy workflow auth.role check', () => {
    expect(migration).toMatch(
      /ALTER POLICY "Authenticated users can view workflow shares"[\s\S]*TO authenticated[\s\S]*USING \(true\)/i
    );
  });

  it('owner-scopes generated video updates and workflow assistant updates', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS "Users can update generated videos."');
    expect(migration).toContain('CREATE POLICY "Users can update own generated videos"');
    expect(migration).toMatch(/bucket_id = 'generated_videos'[\s\S]*\(SELECT auth\.uid\(\)\)::text/i);
    expect(migration).toMatch(
      /Users can update their own workflow canvas assistant proposals[\s\S]*WITH CHECK \(\(SELECT auth\.uid\(\)\) = user_id\)/i
    );
  });
});
