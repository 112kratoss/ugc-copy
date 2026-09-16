import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20260916090000_keep_generation_exposure_with_its_post.sql',
);

/**
 * The behaviour is asserted by pgTAP (generation_exposure_follows_post.test.sql).
 * This pins the migration's shape, so a later edit cannot quietly hand the
 * generation's exposure back to writes that run after the post has committed,
 * let the trigger publish hidden content, or open the revocation queue.
 */
describe('keep generation exposure with its post', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const functionBody = sql.slice(
    sql.indexOf('FUNCTION public.sync_generation_exposure_with_post()'),
    sql.indexOf('ALTER FUNCTION public.sync_generation_exposure_with_post()'),
  );
  const heal = sql.slice(sql.indexOf('WITH drifted AS'));

  it('recomputes the generation copy on every post write that decides exposure', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER posts_sync_generation_exposure\s+AFTER INSERT OR DELETE OR UPDATE OF visibility, archived_at, review_status, showcase_asset_path, generation_id\s+ON public\.posts\s+FOR EACH ROW/,
    );
  });

  it('never makes hidden content or an operator-removed generation public', () => {
    expect(functionBody).toContain("coalesce(NEW.review_status, 'visible') <> 'hidden'");
    expect(functionBody).toContain('generations.moderation_removed_at IS NULL');
  });

  it('queues a dropped or deleted copy, but not an archive, a tombstone or an erasure cascade', () => {
    expect(functionBody).toContain('NEW.showcase_asset_path IS NULL');
    expect(functionBody).toContain("v_reason := 'post_unexposed'");
    expect(functionBody).toContain("v_reason := 'post_deleted'");
    expect(functionBody).toContain('pg_trigger_depth() > 1');
  });

  it('runs as a trusted owner that no API role can call', () => {
    expect(functionBody).toContain('SECURITY DEFINER');
    expect(functionBody).toContain("SET search_path = ''");
    expect(sql).toContain('ALTER FUNCTION public.sync_generation_exposure_with_post()\n  OWNER TO postgres;');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.sync_generation_exposure_with_post\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
  });

  it('keeps the revocation queue to the service role, which can retry but not add', () => {
    expect(sql).toContain('ALTER TABLE public.showcase_media_revocations ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public.showcase_media_revocations FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(sql).toContain('GRANT SELECT, UPDATE, DELETE ON TABLE public.showcase_media_revocations TO service_role;');
  });

  it('heals existing drift toward less exposure only', () => {
    expect(heal).toContain('SET is_public = generations.is_public AND drifted.should_be_public');
    expect(heal).not.toMatch(/is_public\s*=\s*true/i);
    expect(heal).toContain("drifted.visibility = 'private'");
  });
});
