import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260729090000_subject_report_resolution_notes.sql',
), 'utf8');

describe('subject report resolution notes migration', () => {
  it('adds a bounded resolution note column to moderation reports', () => {
    expect(migration).toContain('ALTER TABLE public.moderation_reports');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS resolution_note text');
    expect(migration).toContain('BETWEEN 3 AND 1000');
  });

  it('replaces the three-argument resolver instead of leaving an overload', () => {
    // An overload would let an older caller resolve a report with no rationale
    // and silently bypass the requirement this migration exists to add.
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.resolve_subject_report_for_ops(uuid, uuid, text);');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.resolve_subject_report_for_ops(');
    expect(migration).toContain('p_resolution_note text');
  });

  it('rejects a decision that would leave no rationale', () => {
    expect(migration).toContain("v_note text := nullif(btrim(coalesce(p_resolution_note, '')), '')");
    expect(migration).toContain('IF v_note IS NULL OR char_length(v_note) < 3 OR char_length(v_note) > 1000 THEN');
    expect(migration).toContain('A resolution note of 3 to 1000 characters is required');
  });

  it('persists the note on both the single and duplicate resolution paths', () => {
    // Two distinct UPDATE statements write the note: the comment path that
    // closes every duplicate, and the generic single-report path.
    const noteWrites = migration.match(/resolution_note = v_note/g) ?? [];
    expect(noteWrites.length).toBe(2);
    expect(migration).toContain("'resolution_note', v_note");
  });

  it('preserves the comment lock ordering that prevents moderator deadlocks', () => {
    expect(migration).toContain('FROM public.post_comments AS target');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('set_post_comment_status(');
  });

  it('keeps the resolver restricted to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)\n  FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)\n  TO service_role',
    );
    expect(migration).toContain('SET search_path = public, pg_temp');
  });
});
