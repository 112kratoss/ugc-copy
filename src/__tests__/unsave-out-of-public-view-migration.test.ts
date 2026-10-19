import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20261019211234_unsave_out_of_public_view.sql'),
  'utf8',
);

/** A function's definition, its comments left out. */
function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('\n$$', start))
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

// Review 4 finding #1. The behaviour, against a real database, is pinned in
// supabase/tests/database/post_save_alerts.test.sql and
// src/__tests__/post-save-alert-database.test.ts.
describe('unsave out of public view migration', () => {
  it('asks a post to be public only to save it, never to take a save back', () => {
    const setState = functionBody('set_post_save_state');
    const check = setState.indexOf("RAISE EXCEPTION 'Post is private or not found'");
    expect(check).toBeGreaterThan(setState.indexOf('IF p_should_save THEN'));
    expect(check).toBeLessThan(setState.indexOf('ELSE'));
    expect(setState.slice(setState.indexOf('ELSE'))).not.toContain('visibility');

    const toggle = functionBody('toggle_post_save');
    // A save held is taken off before the post is looked at.
    expect(toggle.indexOf('IF v_exists THEN')).toBeLessThan(toggle.indexOf('SELECT visibility'));
    expect(toggle.slice(toggle.indexOf('IF v_exists THEN'), toggle.indexOf('RETURN false;'))).not.toContain('visibility');
  });

  // Review 5 finding #2: a save racing a tombstone waits for it, then is refused.
  it('reads the visibility to save under the lock the counter update takes, in both', () => {
    expect(functionBody('set_post_save_state')).toMatch(/SELECT post\.visibility\s+INTO v_visibility\s+FROM public\.posts AS post\s+WHERE post\.id = p_post_id\s+FOR NO KEY UPDATE;/);
    expect(functionBody('toggle_post_save')).toMatch(/SELECT visibility\s+INTO v_visibility\s+FROM public\.posts\s+WHERE id = p_post_id\s+FOR NO KEY UPDATE;/);
    for (const name of ['set_post_save_state', 'toggle_post_save']) expect(functionBody(name)).not.toMatch(/FOR SHARE/);
  });

  it('keeps both under the per-save lock, and the service alone may call them', () => {
    for (const name of ['set_post_save_state', 'toggle_post_save']) {
      const body = functionBody(name);
      expect(body.indexOf("pg_advisory_xact_lock(hashtextextended('post-save:'")).toBeGreaterThan(0);
      expect(body.indexOf("pg_advisory_xact_lock(hashtextextended('post-save:'")).toBeLessThan(body.indexOf('DELETE FROM public.post_saves'));
    }
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.toggle_post_save(uuid, uuid) FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.set_post_save_state(uuid, uuid, boolean) TO service_role;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.toggle_post_save(uuid, uuid) TO service_role;');
  });

  it("takes a tombstoned post's saves with the tombstone, in the same statement, and calls for nothing else", () => {
    expect(migration).toMatch(/CREATE TRIGGER posts_remove_saves_when_tombstoned\s+BEFORE UPDATE OF tombstoned_at ON public\.posts\s+FOR EACH ROW\s+WHEN \(OLD\.tombstoned_at IS NULL AND NEW\.tombstoned_at IS NOT NULL\)/);
    const trigger = functionBody('remove_post_saves_when_tombstoned');
    expect(trigger).toContain('DELETE FROM public.post_saves WHERE post_id = NEW.id;');
    expect(trigger).toContain('NEW.save_count := 0;');
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.remove_post_saves_when_tombstoned\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
  });

  it('gives up its locks after five seconds', () => {
    expect(migration.split('\n').find((line) => line.trim() && !line.startsWith('--'))).toBe("SET LOCAL lock_timeout = '5s';");
  });
});
