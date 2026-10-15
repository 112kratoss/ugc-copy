import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', name), 'utf8');

const migration = read('20261015143633_template_moderation_hold.sql');
const graphMigration = read('20260711131023_graph_media_templates.sql');

/** From the function's CREATE line through its GRANT to the service role. */
function activationFunction(sql: string): string[] {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.activate_template_version(');
  const grant = sql.indexOf(') TO service_role;', start);
  expect(start).toBeGreaterThan(-1);
  expect(grant).toBeGreaterThan(start);
  return sql.slice(start, grant + ') TO service_role;'.length).split('\n');
}

function isSubsequence(needles: string[], haystack: string[]): boolean {
  let next = 0;
  for (const line of haystack) {
    if (line === needles[next]) next += 1;
    if (next === needles.length) return true;
  }
  return next === needles.length;
}

describe('template moderation hold migration', () => {
  it('adds the hold as a nullable time on the template', () => {
    expect(migration).toContain('ALTER TABLE public.templates\n  ADD COLUMN IF NOT EXISTS moderation_disabled_at timestamptz;');
    expect(migration).toContain('COMMENT ON COLUMN public.templates.moderation_disabled_at IS');
  });

  it('keeps a held template disabled whichever writer touches it', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS templates_moderation_hold_check');
    expect(migration).toContain(
      'ADD CONSTRAINT templates_moderation_hold_check CHECK (\n'
      + '    moderation_disabled_at IS NULL\n'
      + "    OR (status = 'disabled' AND is_active IS NOT TRUE)\n"
      + '  );',
    );
  });

  it('refuses to publish a held template, read under the row lock before any version is written', () => {
    const lockedRead = migration.indexOf(
      'SELECT moderation_disabled_at\n'
      + '  INTO v_moderation_disabled_at\n'
      + '  FROM public.templates\n'
      + '  WHERE id = p_template_id\n'
      + '    AND creator_user_id = p_creator_id\n'
      + '  FOR UPDATE;',
    );
    const refusal = migration.indexOf(
      '  IF v_moderation_disabled_at IS NOT NULL THEN\n'
      + "    RAISE EXCEPTION 'This template was taken down by moderation and cannot be republished.'\n"
      + "      USING ERRCODE = 'P0001', HINT = 'TEMPLATE_TAKEN_DOWN';\n"
      + '  END IF;',
    );
    const versionInsert = migration.indexOf('INSERT INTO public.template_versions');
    const activation = migration.indexOf("      status = 'active',");

    expect(lockedRead).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(lockedRead);
    expect(versionInsert).toBeGreaterThan(refusal);
    expect(activation).toBeGreaterThan(versionInsert);
  });

  it('keeps the rest of the activation as it was, signature, invoker rights and grants included', () => {
    const original = activationFunction(graphMigration);
    const replaced = activationFunction(migration);

    // The lock statement now reads the hold; every other line survives in order.
    expect(isSubsequence(original.filter((line) => line !== '  PERFORM 1'), replaced)).toBe(true);
    expect(replaced.join('\n')).toContain("LANGUAGE plpgsql\nSET search_path = ''\nAS $$");
    expect(replaced.join('\n')).not.toContain('SECURITY DEFINER');
    expect(replaced.join('\n')).toContain(') FROM PUBLIC, anon, authenticated;');
    expect(migration).not.toContain('DROP FUNCTION');
  });

  it('holds the template when a confirmed report takes it down, including one its creator had disabled', () => {
    const templateBranch = migration.slice(
      migration.indexOf("IF v_report.target_type = 'template' AND p_action = 'resolve' THEN"),
      migration.lastIndexOf('UPDATE public.moderation_reports\n  SET status = CASE'),
    );

    expect(templateBranch).toContain(
      "SELECT target.status <> 'disabled' OR target.is_active IS DISTINCT FROM false\n"
      + '    INTO v_template_disabled',
    );
    expect(templateBranch).toContain(
      "SET status = 'disabled',\n"
      + '        is_active = false,\n'
      + '        moderation_disabled_at = coalesce(target.moderation_disabled_at, v_now)',
    );
    expect(templateBranch).toContain('AND (v_template_disabled OR target.moderation_disabled_at IS NULL);');
    expect(templateBranch.indexOf('INTO v_template_disabled'))
      .toBeLessThan(templateBranch.indexOf('UPDATE public.templates AS target'));
    expect(templateBranch).not.toContain('v_disabled_count');
  });

  it('names the hold in every answer the resolver gives', () => {
    expect(migration.match(/'template_moderation_disabled_at', /g)).toHaveLength(4);
    expect(migration).toContain("'template_moderation_disabled_at', v_template_hold,");
    expect(migration).toContain(
      'SELECT target.status, target.moderation_disabled_at\n'
      + '      INTO v_template_status, v_template_hold',
    );
  });

  it('keeps the resolver in place, service-role only, with its comment take-down untouched', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.resolve_subject_report_for_ops(\n'
      + '  p_report_id uuid,\n'
      + '  p_reviewer_id uuid,\n'
      + '  p_action text,\n'
      + '  p_resolution_note text\n'
      + ')');
    expect(migration).toContain('SECURITY DEFINER\nSET search_path = public, pg_temp');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)\n  FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_subject_report_for_ops(uuid, uuid, text, text)\n  TO service_role',
    );
    expect(migration).toContain("'removed_by_moderation'");
    expect(migration).toContain('WHERE comment_id = v_report.comment_id\n      AND status IN (\'open\', \'reviewing\');');
    // The template lock still comes before the report lock.
    expect(migration.indexOf('FROM public.templates AS target\n    WHERE target.id = v_report.template_id\n    FOR NO KEY UPDATE;'))
      .toBeLessThan(migration.indexOf('WHERE id = p_report_id\n  FOR UPDATE;'));
    expect(migration.match(/resolution_note = v_note/g) ?? []).toHaveLength(3);
  });
});
