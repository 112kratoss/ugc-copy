import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GENERATION_SHARE_SOURCE_SURFACES } from '@/lib/share';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs
  .readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_feed_share_surface.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('feed share surface migration', () => {
  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('replaces the share source surface constraint on both share tables', () => {
    for (const table of ['generation_share_events', 'post_share_events']) {
      expect(migration).toContain(
        `DROP CONSTRAINT IF EXISTS ${table}_source_surface_check`,
      );
      expect(migration).toContain(
        `ADD CONSTRAINT ${table}_source_surface_check`,
      );
    }
  });

  // Whether the *current* constraint matches the TypeScript union is asserted by
  // share-source-surface-migration.test.ts, which reads the effective constraint
  // across all migrations. Asserting it here too would fail this file every time
  // a later migration widened the enum -- which is not what this file is about.
  it('adds the feed surface the previous constraint rejected', () => {
    expect(GENERATION_SHARE_SOURCE_SURFACES).toContain('feed');
    expect(migration).toContain("'feed'");
  });
});
