import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809170000_post_comments_top_sort_index.sql',
), 'utf8');

describe('post comments top sort index migration', () => {
  it('covers the exact ordering the top sort issues', () => {
    // post-comments-service orders by reply_count DESC, then created_at DESC,
    // then id DESC. A partial match on the leading columns would still force a
    // sort, so the whole key has to line up.
    expect(migration).toContain('(post_id, reply_count DESC, created_at DESC, id DESC)');
  });

  it('restricts to top-level comments, which is what the query filters on', () => {
    expect(migration).toContain('WHERE parent_comment_id IS NULL');
  });

  it('does not narrow by status', () => {
    // The listing keeps removed comments that still hold replies
    // (`status = 'active' OR reply_count > 0`), so a status predicate would
    // make the index unusable for half of that disjunction — Postgres cannot
    // match a partial index against a broader query predicate.
    //
    // Asserted against the statement, not the file: the rationale above is
    // also written into the migration's own header comment.
    const statement = migration.slice(migration.indexOf('CREATE INDEX'));
    expect(statement).not.toContain('status');
    expect(migration).toMatch(/not\*? narrowed by status/i);
  });
});
