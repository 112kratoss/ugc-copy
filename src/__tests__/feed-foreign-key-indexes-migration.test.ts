import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs
  .readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_cover_feed_foreign_keys.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('feed foreign-key index migration', () => {
  it('covers every feed foreign key reported by the database advisor', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain(
      'ON public.feed_events (creator_user_id)',
    );
    expect(migration).toContain(
      'ON public.feed_experiment_assignments (experiment_id, variant_id)',
    );
    expect(migration).toContain(
      'ON public.feed_experiment_assignments (viewer_user_id)',
    );
    expect(migration).toContain(
      'ON public.feed_sessions (experiment_assignment_id)',
    );
  });
});
