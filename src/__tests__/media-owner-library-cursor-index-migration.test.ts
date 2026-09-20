import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('indexes the combined owner library without changing access policies', () => {
  const sql = readFileSync('supabase/migrations/20260920155342_media_owner_library_cursor_index.sql', 'utf8');
  expect(sql).toMatch(/ON public.posts \(user_id, created_at DESC, id DESC\)/);
  expect(sql).not.toMatch(/DROP|GRANT|POLICY/);
});
