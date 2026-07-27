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

  it('allows every surface the client can send, so no share is rejected at write time', () => {
    for (const surface of GENERATION_SHARE_SOURCE_SURFACES) {
      expect(migration).toContain(`'${surface}'`);
    }
  });

  it('adds the feed surface the previous constraint rejected', () => {
    expect(GENERATION_SHARE_SOURCE_SURFACES).toContain('feed');
    expect(migration).toContain("'feed'");
  });
});
