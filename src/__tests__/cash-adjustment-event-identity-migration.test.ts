import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(process.cwd(),
  'supabase/migrations/20260929142945_validate_cash_adjustment_event_identity.sql'), 'utf8');

describe('cash adjustment event identity migration', () => {
  it('patches exactly one duplicate branch per function and preserves service-only execution', () => {
    expect(migration).toContain("RAISE EXCEPTION 'Expected one duplicate acknowledgement in %'");
    for (const name of ['reconcile_marketplace_cash_adjustment', 'reconcile_post_resource_cash_adjustment']) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${name}(text,text,text,text,text) FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(text,text,text,text,text) TO service_role;`);
    }
    expect(migration).not.toMatch(/DROP\s+(TABLE|FUNCTION)|TRUNCATE/i);
  });
});
