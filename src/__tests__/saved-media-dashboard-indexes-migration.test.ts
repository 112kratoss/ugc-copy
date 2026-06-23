import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_optimize_saved_media_and_resource_dashboard_indexes.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('saved media and resource dashboard index migration', () => {
  it('supports saved-media pagination by user and newest save first', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS post_saves_user_created_post_idx');
    expect(migration).toContain('ON public.post_saves (user_id, created_at DESC, post_id)');
  });

  it('keeps the legacy saved-media fallback cheap while it exists', () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS showcase_saves_user_created_generation_idx');
    expect(migration).toContain('ON public.showcase_saves (user_id, created_at DESC, generation_id)');
  });

  it('supports seller resource dashboards ordered by newest listing', () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS post_resource_bundles_owner_created_idx');
    expect(migration).toContain('ON public.post_resource_bundles (owner_user_id, created_at DESC, id DESC)');
  });
});
