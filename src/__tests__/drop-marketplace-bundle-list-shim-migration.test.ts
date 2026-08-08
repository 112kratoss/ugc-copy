import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function readMigration(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', name), 'utf8');
}

const migration = readMigration('20260809150000_drop_marketplace_bundle_list_shim.sql');

describe('drop marketplace bundle list shim migration', () => {
  it('drops the 6-argument overload and leaves the 7-argument function alone', () => {
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.list_marketplace_resource_bundles(');
    // Exactly one DROP, and it must not take the query parameter — dropping the
    // 7-argument form would remove the function the app actually calls.
    expect(migration.match(/DROP FUNCTION/g)).toHaveLength(1);
    const args = migration.slice(migration.indexOf('DROP FUNCTION'));
    expect(args.match(/\btext\b/g)).toHaveLength(4);
    expect(args.match(/\binteger\b/g)).toHaveLength(2);
  });

  it('records that this is a footgun removal, not a latency fix', () => {
    // The measurements in F5b show per-call cost is planning plus a fixed
    // PostgREST floor, so this will not move any number. Saying so in the
    // migration stops it being reported later as a performance win that did
    // not materialise.
    expect(migration).toMatch(/no measurable latency change|Expect no measurable/i);
  });

  it('names the ambiguity hazard it closes', () => {
    // Two live overloads are unambiguous only while every caller uses named
    // arguments matching exactly one. F6 hit precisely this and removed the
    // overload rather than living with it.
    expect(migration).toContain('ambiguous');
  });
});
