import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs
  .readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_post_comments.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('post comments migration', () => {
  it('adds the denormalized post comment counter', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0',
    );
  });

  it('creates a backend-owned post_comments table', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.post_comments');
    expect(migration).toContain('ALTER TABLE public.post_comments ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.post_comments FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_comments TO service_role',
    );
    expect(migration).toContain('COMMENT ON TABLE public.post_comments IS');
  });

  it('constrains comment bodies and lifecycle status', () => {
    expect(migration).toContain('CHECK (char_length(body) BETWEEN 1 AND 2000)');
    expect(migration).toContain(
      "status IN ('active', 'removed_by_author', 'removed_by_owner', 'removed_by_moderation')",
    );
  });

  it('keeps replies on the same post as their parent', () => {
    expect(migration).toContain('CONSTRAINT post_comments_post_scope UNIQUE (id, post_id)');
    expect(migration).toContain('CONSTRAINT post_comments_parent_same_post');
    expect(migration).toContain('FOREIGN KEY (parent_comment_id, post_id)');
    expect(migration).toContain(
      'REFERENCES public.post_comments (id, post_id) ON DELETE CASCADE',
    );
  });

  it('indexes the thread read paths', () => {
    expect(migration).toContain('post_comments_toplevel_idx');
    expect(migration).toContain('WHERE parent_comment_id IS NULL');
    expect(migration).toContain('post_comments_parent_idx');
    expect(migration).toContain('WHERE parent_comment_id IS NOT NULL');
    expect(migration).toContain('post_comments_user_idx');
  });

  it('maintains counters inside service-role only rpcs', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.create_post_comment(',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.set_post_comment_status(',
    );
    expect(migration).toContain('SET comment_count = post.comment_count + 1');
    expect(migration).toContain('SET comment_count = greatest(0, post.comment_count - 1)');
    expect(migration).toContain('SET reply_count = parent.reply_count + 1');
    expect(migration).toContain('SET reply_count = greatest(0, parent.reply_count - 1)');

    for (const signature of [
      'public.create_post_comment(uuid, uuid, uuid, text)',
      'public.set_post_comment_status(uuid, uuid, text)',
    ]) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated`,
      );
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
    }
  });

  it('only lets the author or the post owner remove a comment', () => {
    expect(migration).toContain('Only the comment author can delete this comment');
    expect(migration).toContain('Only the post owner can remove this comment');
    expect(migration).toContain("IF v_status = 'active' THEN");
  });

  it('rejects comments on posts that are not publicly visible', () => {
    expect(migration).toContain("AND post.visibility = 'public'");
    expect(migration).toContain('AND post.archived_at IS NULL');
    expect(migration).toContain("AND post.review_status = 'visible'");
    expect(migration).toContain('Post is private or not found');
  });

  it('extends the moderation queue with a comment target', () => {
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS comment_id uuid REFERENCES public.post_comments(id) ON DELETE SET NULL',
    );
    expect(migration).toContain("CHECK (target_type IN ('user', 'generation', 'comment'))");
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS moderation_reports_target_shape');
    expect(migration).toContain(
      "(target_type = 'comment' AND reported_user_id IS NULL AND generation_id IS NULL)",
    );
    expect(migration).toContain("'comments'");
    expect(migration).toContain('moderation_reports_comment_created_idx');
  });
});
