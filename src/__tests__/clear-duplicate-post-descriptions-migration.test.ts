import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261012194135_clear_duplicate_post_descriptions.sql', 'utf8');
// The statement alone: the header names functions and columns it never writes.
const statement = sql.replace(/^--.*$/gm, '').trim();

describe('clear duplicate post descriptions migration', () => {
  it('clears only a description that repeats its own post body', () => {
    expect(statement).toMatch(/^UPDATE public\.posts\s+SET description = NULL,/);
    expect(statement).toContain('WHERE description IS NOT NULL');
    expect(statement).toContain('AND body IS NOT NULL');
    // The create and edit routes fold a body's CRLF to LF and keep the
    // description as sent, so the same caption can differ only in line ends.
    expect(statement).toContain(
      "btrim(replace(description, E'\\r\\n', E'\\n')) = btrim(replace(body, E'\\r\\n', E'\\n'))",
    );
  });

  it('writes nothing but the description and its timestamp', () => {
    // The body is the text that stays; the title, format and visibility are
    // not this cleanup's to touch, and a mixed post must stay mixed.
    expect(statement).toMatch(/SET description = NULL,\s+updated_at = timezone\('utc'::text, now\(\)\)\s+WHERE/);
    expect(statement).not.toMatch(/\b(body|title|post_format|visibility|is_nsfw)\s*=\s*(?!btrim)/i);
    expect(statement.match(/;/g)).toHaveLength(1);
    expect(statement).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT|REVOKE|DELETE|INSERT)\b/i);
  });

  it('leaves the posts of an account being deleted alone, which the content freeze would refuse', () => {
    // reject_post_write_during_account_deletion raises on a direct write to
    // such a post; one matching row would fail the migration and the release.
    expect(statement).toContain('AND NOT public.is_account_deletion_requested(user_id)');
  });

  it('matches nothing on a replay', () => {
    // A cleared row no longer passes `description IS NOT NULL`.
    expect(statement).toMatch(/SET description = NULL[\s\S]*WHERE description IS NOT NULL/);
  });
});
