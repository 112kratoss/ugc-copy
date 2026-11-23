import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261123182749_refund_backend_rate_limit.sql',
);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * pgTAP (backend_rate_limit_refund.test.sql) pins the behaviour: the named window only, never
 * below zero, service role only. This pins the shape of the one function the migration adds.
 */
describe('the backend rate-limit refund migration', () => {
  const sql = code(readFileSync(MIGRATION_PATH, 'utf8'));

  it('adds one owner-run function with an empty search path', () => {
    expect(sql.match(/CREATE (OR REPLACE )?FUNCTION/gi)).toHaveLength(1);
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.refund_backend_rate_limit( p_scope text, p_subject_key text, p_window_start timestamptz ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = \'\'',
    );
  });

  it('takes one count from the named window of the trimmed scope and subject, never below zero', () => {
    expect(sql).toContain('UPDATE public.backend_rate_limits SET request_count = request_count - 1');
    expect(sql).toContain('WHERE scope = pg_catalog.btrim(coalesce(p_scope, \'\'))');
    expect(sql).toContain('AND subject_key = pg_catalog.btrim(coalesce(p_subject_key, \'\'))');
    expect(sql).toContain('AND window_start = p_window_start');
    expect(sql).toContain('AND request_count > 0;');
    expect(sql).toContain('RETURN FOUND;');
    expect(sql).not.toMatch(/\bDELETE\b|\bINSERT\b/i);
  });

  it('is callable by the service role alone, like the check it undoes', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.refund_backend_rate_limit(text, text, timestamptz) FROM PUBLIC;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.refund_backend_rate_limit(text, text, timestamptz) FROM anon, authenticated;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.refund_backend_rate_limit(text, text, timestamptz) TO service_role;',
    );
    expect(sql.match(/\bGRANT\b/g)).toHaveLength(1);
  });

  it('changes nothing else: no table, index or other function', () => {
    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE INDEX|DROP /i);
    expect(sql).not.toContain('check_backend_rate_limit(');
  });
});
