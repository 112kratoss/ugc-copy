import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GENERATION_SHARE_SOURCE_SURFACES } from '@/lib/share';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const SHARE_EVENT_TABLES = ['generation_share_events', 'post_share_events'] as const;

/**
 * The share source surface is stated twice: once as a TypeScript union the
 * clients send, once as a database CHECK constraint. A value in one and not the
 * other is a silently lost share event — the client passes its own guard and the
 * insert is rejected, or the reverse.
 *
 * Reading the *effective* constraint rather than one named migration is what
 * makes this hold as new surfaces arrive. The previous version of this test
 * asserted against a single file, so the next migration to widen the enum would
 * have failed it for the wrong reason.
 */
function readEffectiveSurfaces(table: string): string[] | null {
  const migrations = fs.readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
  const pattern = new RegExp(
    `ADD\\s+CONSTRAINT\\s+${table}_source_surface_check\\s+CHECK\\s*\\(\\s*source_surface\\s+IN\\s*\\(([^)]*)\\)`,
    'gi',
  );

  let effective: string[] | null = null;

  for (const name of migrations) {
    const sql = fs.readFileSync(path.join(migrationsDirectory, name), 'utf8');
    for (const match of sql.matchAll(pattern)) {
      effective = [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]);
    }
  }

  return effective;
}

describe('share source surface constraints', () => {
  for (const table of SHARE_EVENT_TABLES) {
    it(`keeps ${table} in step with the surfaces the clients can send`, () => {
      const surfaces = readEffectiveSurfaces(table);

      expect(surfaces, `no CHECK constraint found for ${table}`).not.toBeNull();
      // Both directions: a surface the client sends that the database rejects is
      // a lost event, and a surface the database allows that no client knows
      // about is dead vocabulary nobody will notice has rotted.
      expect(new Set(surfaces)).toEqual(new Set(GENERATION_SHARE_SOURCE_SURFACES));
    });
  }

  it('carries the mobile reel surface, so a reel share is not reported as a detail-page share', () => {
    expect(GENERATION_SHARE_SOURCE_SURFACES).toContain('showcase-reel');

    for (const table of SHARE_EVENT_TABLES) {
      expect(readEffectiveSurfaces(table)).toContain('showcase-reel');
    }
  });

  it('never drops a previously accepted surface, so shares from older mobile builds still record', () => {
    // Mobile ships through store review days after the web release, so builds in
    // the wild keep sending the vocabulary they were compiled with.
    for (const table of SHARE_EVENT_TABLES) {
      expect(readEffectiveSurfaces(table)).toEqual(
        expect.arrayContaining(['detail-page', 'showcase', 'feed', 'creator-profile', 'my-creations']),
      );
    }
  });
});
