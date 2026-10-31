import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261031070617_deleted_post_queues_its_media_rows.sql',
);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * The behaviour is asserted by pgTAP (deleted_post_derivatives.test.sql). This
 * pins the migration's shape: the paths are read before the delete cascades to
 * the media rows, only account erasure's cascade is left to its sweep, and the
 * trigger can never cancel the delete it runs for.
 */
describe("a deleted post queues its media rows' paths", () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const functionBody = sql.slice(
    sql.indexOf('CREATE FUNCTION public.queue_deleted_post_media_revocations()'),
    sql.indexOf('ALTER FUNCTION public.queue_deleted_post_media_revocations()'),
  );

  it('waits at most five seconds for the posts lock', () => {
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(-1);
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s';"))
      .toBeLessThan(sql.indexOf('CREATE TRIGGER posts_queue_deleted_post_media'));
  });

  it('runs before the delete cascades to the media rows', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER posts_queue_deleted_post_media\s+BEFORE DELETE ON public\.posts\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.queue_deleted_post_media_revocations\(\);/,
    );
  });

  it('lets every delete through: a BEFORE trigger that returns NULL cancels it', () => {
    expect(code(functionBody)).not.toMatch(/RETURN NULL/i);
    expect(code(functionBody).match(/RETURN OLD;/g)).toHaveLength(3);
  });

  it("leaves account erasure's cascade to the erasure sweep, and no other delete", () => {
    // The cascade from auth.users runs once the owner's row is gone. Trigger
    // depth would also skip a direct delete issued from inside a trigger.
    expect(code(functionBody)).toContain(
      'IF NOT EXISTS ( SELECT 1 FROM auth.users AS users WHERE users.id = OLD.user_id ) THEN RETURN OLD; END IF;',
    );
    expect(functionBody).not.toContain('pg_trigger_depth');
  });

  it('queues under a live creation of the owner or a linked guest, whatever an operator did, or under the deleted one the post recorded', () => {
    expect(code(functionBody)).toContain(
      'IF OLD.generation_id IS NULL THEN v_folder_id := OLD.deleted_generation_id; ELSE',
    );
    expect(code(functionBody)).toContain(
      'WHERE generations.id = OLD.generation_id AND ( generations.user_id = OLD.user_id OR EXISTS ( SELECT 1 FROM public.profiles AS owner WHERE owner.id = generations.user_id AND owner.merged_into_user_id = OLD.user_id ) );',
    );
    // An operator's removal hides the creation; the job keeps what it names.
    expect(functionBody).not.toContain('moderation_removed_at');
    expect(code(functionBody)).toContain('IF v_folder_id IS NULL THEN RETURN OLD; END IF;');
  });

  it("queues every path the post's rows name in the creation's public folder, once", () => {
    for (const column of ['storage_path', 'preview_storage_path', 'display_storage_path', 'rendition_storage_path', 'teaser_storage_path']) {
      expect(functionBody).toContain(`media.${column}`);
    }
    expect(code(functionBody)).toContain('WHERE media.post_id = OLD.id');
    expect(code(functionBody)).toContain("AND starts_with(named.path, 'showcase/' || v_folder_id::text || '/')");
    expect(code(functionBody)).toContain("SELECT DISTINCT v_folder_id, OLD.id, named.path, 'post_deleted'");
    expect(code(functionBody)).toContain('ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;');
  });

  it('runs as a trusted owner that no API role can call, and changes nothing else', () => {
    expect(functionBody).toContain('SECURITY DEFINER');
    expect(functionBody).toContain("SET search_path = ''");
    expect(sql).toContain('ALTER FUNCTION public.queue_deleted_post_media_revocations()\n  OWNER TO postgres;');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.queue_deleted_post_media_revocations\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).not.toMatch(/CREATE OR REPLACE|GRANT |ALTER TABLE|DROP /i);
  });
});
