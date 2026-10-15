import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261015122821_moderation_reports_template_target.sql',
), 'utf8');

describe('moderation reports template target migration', () => {
  it('widens the target type the way the comment target was added', () => {
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.templates(id) ON DELETE SET NULL',
    );
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS moderation_reports_target_type_check');
    expect(migration).toContain(
      "CHECK (target_type IN ('user', 'generation', 'comment', 'template'))",
    );
  });

  it('gives a template report its own shape and keeps the template column empty on the others', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS moderation_reports_target_shape');
    expect(migration).toContain(
      "(target_type = 'user' AND generation_id IS NULL AND comment_id IS NULL AND template_id IS NULL)",
    );
    expect(migration).toContain(
      "OR (target_type = 'generation' AND reported_user_id IS NULL AND comment_id IS NULL AND template_id IS NULL)",
    );
    expect(migration).toContain(
      "OR (target_type = 'comment' AND reported_user_id IS NULL AND generation_id IS NULL AND template_id IS NULL)",
    );
    expect(migration).toContain(
      "OR (target_type = 'template' AND reported_user_id IS NULL AND generation_id IS NULL AND comment_id IS NULL)",
    );
  });

  it('accepts the post-content reasons and the template page as a surface', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS moderation_reports_reason_check');
    const reasonCheck = migration.slice(
      migration.indexOf('ADD CONSTRAINT moderation_reports_reason_check'),
      migration.indexOf('DROP CONSTRAINT IF EXISTS moderation_reports_source_surface_check'),
    );
    for (const reason of [
      'spam',
      'harassment',
      'impersonation',
      'unsafe_content',
      'offensive_ai_output',
      'stolen_content',
      'other',
    ]) {
      expect(reasonCheck).toContain(`'${reason}'`);
    }
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS moderation_reports_source_surface_check');
    expect(migration).toContain("'template-detail'");
  });

  it('lets one reporter hold one open report per template, guarded by a unique index', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS moderation_reports_one_open_template_report_idx\n'
      + '  ON public.moderation_reports (template_id, reporter_user_id)\n'
      + "  WHERE target_type = 'template' AND status IN ('open', 'reviewing');",
    );
    expect(migration).toContain('ON public.moderation_reports (template_id, created_at DESC)');
  });

  it('replaces the four-argument resolver in place rather than adding an overload', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.resolve_subject_report_for_ops(\n'
      + '  p_report_id uuid,\n'
      + '  p_reviewer_id uuid,\n'
      + '  p_action text,\n'
      + '  p_resolution_note text\n'
      + ')');
    expect(migration).not.toContain('DROP FUNCTION');
    expect(migration).toContain('IF v_note IS NULL OR char_length(v_note) < 3 OR char_length(v_note) > 1000 THEN');
  });

  it('locks the template before the report, as the comment path locks the comment', () => {
    const templateLock = migration.indexOf(
      'FROM public.templates AS target\n    WHERE target.id = v_report.template_id\n    FOR NO KEY UPDATE;',
    );
    const reportLock = migration.indexOf('WHERE id = p_report_id\n  FOR UPDATE;');
    expect(templateLock).toBeGreaterThan(-1);
    expect(reportLock).toBeGreaterThan(templateLock);
  });

  it('takes a confirmed template down and closes every duplicate report with the same note', () => {
    const templateBranch = migration.slice(
      migration.indexOf("IF v_report.target_type = 'template' AND p_action = 'resolve' THEN"),
      migration.lastIndexOf('UPDATE public.moderation_reports\n  SET status = CASE'),
    );
    expect(templateBranch).toContain("SET status = 'disabled',\n        is_active = false");
    expect(templateBranch).toContain('WHERE template_id = v_report.template_id\n      AND status IN (\'open\', \'reviewing\');');
    expect(templateBranch).toContain("'template_disabled', v_template_disabled");
    expect(templateBranch).toContain("'resolved_report_count', v_resolved_count");
    // The comment, template and single-report paths each write the note.
    expect(migration.match(/resolution_note = v_note/g) ?? []).toHaveLength(3);
  });

  it('keeps the comment take-down unchanged', () => {
    expect(migration).toContain("'removed_by_moderation'");
    expect(migration).toContain('WHERE comment_id = v_report.comment_id\n      AND status IN (\'open\', \'reviewing\');');
  });

  it('keeps the resolver restricted to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)\n  FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)\n  TO service_role',
    );
    expect(migration).toContain('SECURITY DEFINER\nSET search_path = public, pg_temp');
  });
});
