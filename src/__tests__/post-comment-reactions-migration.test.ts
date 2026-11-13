import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261113191038_post_comment_reactions_heart_pin_edit.sql',
), 'utf8');
const service = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/post-comments-service.ts'), 'utf8');

// Likes and dislikes, the creator's heart, the pinned comment and edits. Their
// behaviour is held by supabase/tests/database/post_comment_reactions.test.sql,
// which needs a database; this holds the statements the rest of the code and
// the release lean on, wherever the suite runs.
describe('post comment reactions migration', () => {
  it('keeps both new tables and all four functions off the Data API', () => {
    for (const table of ['post_comment_reactions', 'post_comment_edits']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
    }
    for (const signature of [
      'set_post_comment_reaction(uuid, uuid, text)',
      'edit_post_comment(uuid, uuid, text)',
      'set_post_comment_heart(uuid, uuid, boolean)',
      'set_post_comment_pin(uuid, uuid, boolean)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    // No grant to a client role anywhere in the file.
    expect(migration).not.toMatch(/GRANT[^;]*\bTO\s+(anon|authenticated|PUBLIC)\b/i);
  });

  it('makes the edit history append-only for the service role too', () => {
    // A table is born with the full service_role grant set.
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.post_comment_edits FROM service_role;',
    );
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.post_comment_edits TO service_role;');
  });

  it('holds a post to one pin, on a top-level comment, and a removed comment to no marks', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS post_comments_one_pin_per_post_idx\s+ON public\.post_comments \(post_id\)\s+WHERE pinned_at IS NOT NULL;/,
    );
    expect(migration).toContain('CHECK (pinned_at IS NULL OR parent_comment_id IS NULL)');
    expect(migration).toContain("CHECK (status = 'active' OR (pinned_at IS NULL AND hearted_at IS NULL))");
    // Cleared in the update that removes the comment, whichever path removes it.
    expect(migration).toMatch(
      /CREATE TRIGGER post_comments_clear_marks_on_removal\s+BEFORE UPDATE OF status ON public\.post_comments/,
    );
  });

  it('counts reactions by trigger, so a deleted account\'s likes leave the count', () => {
    expect(migration).toMatch(
      /user_id uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER post_comment_reactions_apply_counts\s+AFTER INSERT OR UPDATE OR DELETE ON public\.post_comment_reactions/,
    );
  });

  it('indexes the exact ordering the top sort issues, and retires the index it replaces', () => {
    // post-comments-service orders by like_count DESC, reply_count DESC, then
    // created_at DESC and id DESC. A match on the leading columns alone would
    // still force a sort, so the whole key has to line up.
    expect(migration).toContain(
      '(post_id, like_count DESC, reply_count DESC, created_at DESC, id DESC)\n  WHERE parent_comment_id IS NULL;',
    );
    expect(migration).toContain('DROP INDEX IF EXISTS public.post_comments_toplevel_top_idx;');
    expect(service).toMatch(
      /\.order\('like_count', \{ ascending: false \}\)\s*\.order\('reply_count', \{ ascending: false \}\)/,
    );
  });

  it('never selects the dislike count for a client', () => {
    expect(service).not.toContain('dislike_count');
    expect(service).not.toContain('dislikeCount');
  });

  it('never has the pin hold the post\'s row while it waits for a comment', () => {
    // Every other comment write locks a comment, then the post. A pin that
    // locked the post first deadlocked with a reply to, or the removal of, the
    // comment being pinned; pgTAP is one session and cannot show that, so the
    // order is held here.
    const pin = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.set_post_comment_pin('),
      migration.indexOf('REVOKE ALL ON FUNCTION public.set_post_comment_reaction'),
    );
    expect(pin).toContain("pg_advisory_xact_lock(hashtextextended('post-comment-pin:post:' || v_post_id::text, 0))");
    expect(pin).not.toMatch(/FROM public\.posts AS post\s+WHERE post\.id = v_post_id\s+FOR /);
    expect(pin).toMatch(/ORDER BY held\.id\s+FOR UPDATE;/);
    // No statement of the pin writes the post.
    expect(pin).not.toMatch(/UPDATE public\.posts\b/);
  });

  it('raises the three refusals the service answers as 404', () => {
    // updatePostCommentForRoute reads these words to tell a lost race from a fault.
    for (const refusal of ['Comment not found', 'Comment is not available', 'Post is private or not found']) {
      expect(migration).toContain(`RAISE EXCEPTION '${refusal}'`);
      expect(service).toContain(refusal);
    }
  });
});
