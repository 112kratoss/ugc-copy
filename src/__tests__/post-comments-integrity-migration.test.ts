import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260728143000_post_comments_integrity.sql',
), 'utf8');

describe('post comments integrity migration', () => {
  it('serializes status transitions before changing counters', () => {
    expect(migration).toContain('FOR UPDATE OF target');
    expect(migration).toContain("AND target.status = 'active'");
    expect(migration).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT');
    expect(migration).toContain('IF v_changed THEN');
  });

  it('anonymizes account-deletion comments without cascading the thread', () => {
    expect(migration).toContain('ALTER COLUMN user_id DROP NOT NULL');
    expect(migration).toContain(
      'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL',
    );
    expect(migration).toContain('auth_users_anonymize_post_comments_before_delete');
    expect(migration).toContain("SET status = 'removed_by_author'");
    expect(migration).toContain('RETURNING target.post_id, target.parent_comment_id');
  });

  it('enforces the one-level reply contract in the database', () => {
    expect(migration).toContain('v_parent_parent_comment_id');
    expect(migration).toContain("RAISE EXCEPTION 'Replies can only target top-level comments'");
    expect(migration).toContain('FOR UPDATE;');
  });

  it('provides an atomic service-role-only comment moderation action', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.resolve_subject_report_for_ops(',
    );
    expect(migration).toContain("'removed_by_moderation'");
    expect(migration).toContain("WHERE comment_id = v_report.comment_id");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text)',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text)',
    );
  });

  it('repairs legacy post and reply counter drift', () => {
    expect(migration).toContain('SET comment_count = counters.active_count');
    expect(migration).toContain('SET reply_count = counters.active_count');
    expect(migration).toContain("comment.status = 'active'");
    expect(migration).toContain("reply.status = 'active'");
  });
});
