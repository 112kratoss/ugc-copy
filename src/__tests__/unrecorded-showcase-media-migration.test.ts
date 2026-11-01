import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261101100659_sweeps_queue_unrecorded_showcase_media.sql',
);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * The behaviour is asserted by pgTAP (unrecorded_showcase_media.test.sql) and
 * on a real stack (showcase-revocation-postgrest.test.ts). This pins the shape:
 * the queue keeps its reasons and gains one, only the service role can add to
 * it, and only paths in a creation's public folder are ever queued.
 */
describe('the sweeps queue what no row update recorded', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const functionBody = sql.slice(
    sql.indexOf('CREATE FUNCTION public.queue_unrecorded_showcase_media('),
    sql.indexOf('ALTER FUNCTION public.queue_unrecorded_showcase_media('),
  );

  it('waits at most five seconds for the queue lock', () => {
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(-1);
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s';")).toBeLessThan(sql.indexOf('ALTER TABLE'));
  });

  it('adds the sweeps’ reason and keeps every reason the triggers write', () => {
    expect(code(sql)).toContain(
      "ALTER TABLE public.showcase_media_revocations DROP CONSTRAINT showcase_media_revocations_reason_check, ADD CONSTRAINT showcase_media_revocations_reason_check CHECK (reason IN ('post_unexposed', 'post_deleted', 'exposure_drift', 'sweep_unrecorded'));",
    );
  });

  it("queues only paths in a creation's public folder, under that creation, once", () => {
    expect(code(functionBody)).toContain(
      "INSERT INTO public.showcase_media_revocations (generation_id, showcase_asset_path, reason) SELECT DISTINCT split_part(named.path, '/', 2)::uuid, named.path, 'sweep_unrecorded' FROM unnest(p_paths) AS named(path) WHERE named.path ~ '^showcase/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]' ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;",
    );
  });

  it('refuses a bulk hand-off', () => {
    expect(code(functionBody)).toContain('IF cardinality(p_paths) > 50 THEN RAISE EXCEPTION');
    expect(code(functionBody)).toContain("USING ERRCODE = '22023';");
  });

  it('runs as a trusted owner that only the service role can call', () => {
    expect(functionBody).toContain('SECURITY DEFINER');
    expect(functionBody).toContain("SET search_path = ''");
    expect(code(sql)).toContain('ALTER FUNCTION public.queue_unrecorded_showcase_media(text[]) OWNER TO postgres;');
    expect(code(sql)).toContain(
      'REVOKE ALL ON FUNCTION public.queue_unrecorded_showcase_media(text[]) FROM PUBLIC, anon, authenticated;',
    );
    expect(code(sql)).toContain(
      'GRANT EXECUTE ON FUNCTION public.queue_unrecorded_showcase_media(text[]) TO service_role;',
    );
  });

  it("names the sweeps among the queue's sources", () => {
    expect(code(sql)).toContain('COMMENT ON TABLE public.showcase_media_revocations IS');
    expect(sql).toContain('and by the media sweeps for uploads no update recorded');
  });

  it('changes nothing else: no new grant on the queue, no replaced function', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE/i);
    expect(sql).not.toMatch(/GRANT [A-Z, ]+ ON TABLE/i);
    expect(sql.match(/^GRANT /gm)).toHaveLength(1);
    expect(sql.match(/^ALTER TABLE /gm)).toHaveLength(1);
  });
});
