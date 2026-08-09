import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809220000_fix_update_post_owner_guard.sql',
), 'utf8');

// The header comment deliberately quotes the broken fragment it is fixing, so
// the guard assertions run against the function body alone.
const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'));

describe('fix update post owner guard migration', () => {
  it('recreates the function the 20260806 migration broke', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.update_post_with_resource_bundle(',
    );
  });

  it('restores the plain owner guard and drops the undeclared-record fragment', () => {
    // `v_bundle` was never declared, so `v_bundle.status` resolved as a missing
    // FROM-clause reference and raised on every call since 2026-08-06.
    expect(body).toContain('IF NOT FOUND THEN');
    expect(body).not.toContain('v_bundle.status');
    expect(body).toContain("RAISE EXCEPTION 'Post not found or not owned by user';");
  });

  it('keeps the row lock the 20260806 migration introduced', () => {
    expect(body).toContain('FOR UPDATE;');
    expect(body.indexOf('FOR UPDATE;'))
      .toBeLessThan(body.indexOf('IF NOT FOUND THEN'));
  });

  it('stays service-role only', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)',
    );
    expect(migration).toContain('TO service_role;');
  });
});
