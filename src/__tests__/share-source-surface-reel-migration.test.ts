import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs
  .readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_share_source_surface_reel.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('share source surface reel migration', () => {
  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('replaces the constraint on both share tables', () => {
    for (const table of ['generation_share_events', 'post_share_events']) {
      expect(migration).toContain(`DROP CONSTRAINT IF EXISTS ${table}_source_surface_check`);
      expect(migration).toContain(`ADD CONSTRAINT ${table}_source_surface_check`);
    }
  });

  it('adds the reel surface both clients now send', () => {
    expect(migration).toContain("'showcase-reel'");
  });

  it('is purely additive, so mobile builds awaiting store review keep recording', () => {
    // The web release lands days before the store build. Every value the shipped
    // app can send must survive this migration or those shares vanish.
    for (const surface of [
      'create-image',
      'create-video',
      'create-motion',
      'my-creations',
      'creator-profile',
      'showcase',
      'detail-page',
      'feed',
    ]) {
      expect(migration).toContain(`'${surface}'`);
    }
  });
});
