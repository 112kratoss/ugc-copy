import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readMigration(name: string) {
  return readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
}

/** One function's statement, from its CREATE through the closing `$$;`. */
function functionText(sql: string, start: string) {
  const from = sql.indexOf(start);
  expect(from, `${start} is not in the migration`).toBeGreaterThanOrEqual(0);
  return sql.slice(from, sql.indexOf('$$;', from) + 3);
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments, which the replaced bodies may add. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

const MIGRATION = '20261030151942_post_keeps_its_deleted_creation_folder.sql';

/**
 * The behaviour is asserted by pgTAP (deleted_creation_copy.test.sql). This pins
 * the migration's shape: a trigger owns the new column, the backfill runs before
 * it with PR #598's proof, and each function it replaces changes only in the
 * clause that names the deleted creation's folder.
 */
describe("a post keeps its deleted creation's folder", () => {
  const sql = readMigration(MIGRATION);

  it('waits at most five seconds for the posts lock', () => {
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(-1);
    expect(sql.indexOf("SET LOCAL lock_timeout = '5s';")).toBeLessThan(sql.indexOf('ALTER TABLE public.posts'));
  });

  it('records the deleted creation on the post, never alongside a live link', () => {
    expect(sql).toMatch(/ALTER TABLE public\.posts\s+ADD COLUMN deleted_generation_id uuid;/);
    expect(sql).toMatch(
      /ADD CONSTRAINT posts_deleted_generation_unlinked\s+CHECK \(generation_id IS NULL OR deleted_generation_id IS NULL\);/,
    );
    expect(sql).toMatch(
      /CREATE INDEX posts_deleted_generation_id_idx\s+ON public\.posts \(deleted_generation_id\)\s+WHERE deleted_generation_id IS NOT NULL;/,
    );
    expect(sql).toContain('COMMENT ON COLUMN public.posts.deleted_generation_id IS');
  });

  it('lets only the creation delete write the column, as a trusted trigger no API role can call', () => {
    const trigger = functionText(sql, 'CREATE FUNCTION public.record_deleted_post_generation()');
    expect(trigger).toContain('SECURITY DEFINER');
    expect(trigger).toContain("SET search_path = ''");
    // The FK's SET NULL runs once the creation's row is gone; a link removed
    // while the creation exists records nothing.
    expect(code(trigger)).toContain(
      'ELSIF OLD.generation_id IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM public.generations AS generations WHERE generations.id = OLD.generation_id ) THEN NEW.deleted_generation_id := OLD.generation_id;',
    );
    expect(code(trigger)).toContain("IF TG_OP = 'INSERT' OR NEW.generation_id IS NOT NULL THEN NEW.deleted_generation_id := NULL;");
    expect(code(trigger)).toContain('ELSE NEW.deleted_generation_id := OLD.deleted_generation_id;');
    expect(sql).toMatch(
      /CREATE TRIGGER posts_record_deleted_generation\s+BEFORE INSERT OR UPDATE OF generation_id, deleted_generation_id\s+ON public\.posts\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.record_deleted_post_generation\(\);/,
    );
    expect(sql).toContain('ALTER FUNCTION public.record_deleted_post_generation()\n  OWNER TO postgres;');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_deleted_post_generation\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
  });

  it("backfills posts unlinked before it by #598's proof, before the trigger owns the column", () => {
    const backfill = sql.slice(sql.indexOf('WITH named AS ('), sql.indexOf('CREATE FUNCTION public.record_deleted_post_generation()'));
    expect(backfill).toContain('SET deleted_generation_id = proven.folder_id');
    expect(sql.indexOf('SET deleted_generation_id = proven.folder_id'))
      .toBeLessThan(sql.indexOf('CREATE TRIGGER posts_record_deleted_generation'));
    // One creation folder among the post's own paths, not its own folder.
    expect(backfill).toContain('WHERE posts.generation_id IS NULL');
    expect(backfill).toContain("'(?:^|/)(?:showcase|private-posts)/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/'");
    for (const column of ['showcase_asset_path', 'output_url', 'storage_path', 'preview_storage_path', 'display_storage_path', 'rendition_storage_path', 'teaser_storage_path']) {
      expect(backfill).toContain(column);
    }
    expect(backfill).toContain('named.folder_id <> named.post_id');
    // An owner's pending erasure owns the post's media, and its freeze refuses the write.
    expect(backfill).toContain('AND NOT public.is_account_deletion_requested(posts.user_id)');
    expect(backfill).toContain('HAVING count(DISTINCT named.folder_id) = 1');
    // No creation by that id, and no other post or media row naming the folder.
    expect(code(backfill)).toContain('AND NOT EXISTS ( SELECT 1 FROM public.generations AS generations WHERE generations.id = proven.folder_id )');
    expect(code(backfill)).toContain('WHERE other.id <> proven.post_id');
    expect(code(backfill)).toContain('WHERE media.post_id <> proven.post_id');
    expect(backfill.match(/named_path\.path LIKE \('%\/' \|\| proven\.folder_id::text \|\| '\/%'\)/g)).toHaveLength(2);
  });

  it("queues the copy a deleted creation's post stops needing, and changes nothing else in the exposure trigger", () => {
    const replaced = functionText(sql, 'CREATE OR REPLACE FUNCTION public.sync_generation_exposure_with_post()');
    const previous = functionText(
      readMigration('20261015054611_merge_carries_guest_feed_preferences.sql'),
      'CREATE OR REPLACE FUNCTION public.sync_generation_exposure_with_post()',
    );
    const queue = [
      'IF v_reason IS NOT NULL AND v_deleted_generation_id IS NOT NULL THEN',
      'INSERT INTO public.showcase_media_revocations ( generation_id, post_id, showcase_asset_path, reason )',
      'SELECT v_deleted_generation_id, v_post_id, v_dropped_path, v_reason',
      "WHERE nullif(btrim(v_dropped_path), '') IS NOT NULL",
      'ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;',
      'END IF;',
    ].join(' ');
    expect(code(replaced)).toContain(`IF v_generation_id IS NULL OR v_owner_user_id IS NULL THEN ${queue} RETURN NULL; END IF;`);

    const withoutDeletedCreation = code(replaced)
      .replace(` ${queue}`, '')
      .replace(' v_deleted_generation_id uuid;', '')
      .replace(' v_deleted_generation_id := OLD.deleted_generation_id;', '')
      .replace(' v_deleted_generation_id := NEW.deleted_generation_id;', '');
    expect(withoutDeletedCreation).toBe(code(previous));
    expect(sql).toContain('ALTER FUNCTION public.sync_generation_exposure_with_post()\n  OWNER TO postgres;');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.sync_generation_exposure_with_post\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
    );
  });

  it("lists a deleted creation's copy in the erasure manifest, and changes nothing else in it", () => {
    const replaced = functionText(sql, 'CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)');
    const previous = functionText(
      readMigration('20260920190000_private_uploaded_post_media.sql'),
      'CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)',
    );
    const before = "OR (starts_with(btrim(paths.path), 'showcase/' || p.generation_id::text || '/') AND EXISTS ( SELECT 1 FROM public.generations g WHERE g.id=p.generation_id AND g.user_id=any(v_owner_ids) ))";
    const after = "OR ((starts_with(btrim(paths.path), 'showcase/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/') OR starts_with(btrim(paths.path), 'private-posts/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/')) AND (p.generation_id IS NULL OR EXISTS ( SELECT 1 FROM public.generations g WHERE g.id=p.generation_id AND g.user_id=any(v_owner_ids) )))";
    expect(code(previous)).toContain(before);
    expect(code(replaced)).toContain(after);
    expect(code(replaced).replace(after, before)).toBe(code(previous));
  });

  it("reads a deleted creation's private copy through its post, and changes nothing else in the read", () => {
    const replaced = functionText(sql, 'create or replace function public.can_read_private_post_media(');
    const previous = functionText(
      readMigration('20261015013717_nsfw_purchase_entitlement.sql'),
      'create or replace function public.can_read_private_post_media(',
    );
    const before = "where (p.id=split_part(p_path,'/',2)::uuid or p.generation_id=split_part(p_path,'/',2)::uuid)";
    const after = "where (p.id=split_part(p_path,'/',2)::uuid or p.generation_id=split_part(p_path,'/',2)::uuid or p.deleted_generation_id=split_part(p_path,'/',2)::uuid)";
    expect(code(replaced)).toContain(after);
    expect(code(replaced).replace(after, before)).toBe(code(previous));
    expect(sql).toContain('revoke all on function public.can_read_private_post_media(text,uuid) from public,anon,authenticated;');
    expect(sql).toContain('grant execute on function public.can_read_private_post_media(text,uuid) to service_role;');
  });

  it("admits a deleted creation's rendition to the teaser sweep, and changes nothing else in the claim", () => {
    const start = 'CREATE OR REPLACE FUNCTION public.claim_post_media_teaser_repair(';
    const teaserClaim = (text: string) => {
      const from = text.indexOf(start);
      expect(from, 'the teaser claim is not in the migration').toBeGreaterThanOrEqual(0);
      return text.slice(from, text.indexOf('$function$;', from) + '$function$;'.length);
    };
    const replaced = teaserClaim(sql);
    const previous = teaserClaim(readMigration('20260920190000_private_uploaded_post_media.sql'));
    const substitutions: Array<[string, string]> = [
      [
        'select pm.id, p.generation_id, sz.bytes',
        'select pm.id, coalesce(p.generation_id, p.deleted_generation_id) as generation_id, sz.bytes',
      ],
      [
        "p.generation_id is not null and starts_with(pm.rendition_storage_path, 'showcase/' || p.generation_id::text || '/')",
        "coalesce(p.generation_id, p.deleted_generation_id) is not null and starts_with(pm.rendition_storage_path, 'showcase/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/')",
      ],
    ];
    let restored = code(replaced);
    for (const [before, after] of substitutions) {
      expect(restored).toContain(after);
      restored = restored.replace(after, before);
    }
    expect(restored).toBe(code(previous));
    expect(sql).toContain('revoke all on function public.claim_post_media_teaser_repair(text, bigint) from public, anon, authenticated;');
    expect(sql).toContain('grant execute on function public.claim_post_media_teaser_repair(text, bigint) to service_role;');
  });

  it("keeps a deleted creation's media out of replace_post_media, and changes nothing else in it", () => {
    const replaced = functionText(sql, 'CREATE OR REPLACE FUNCTION public.replace_post_media(');
    const previous = functionText(
      readMigration('20260813120000_post_media_teaser_renditions.sql'),
      'CREATE OR REPLACE FUNCTION public.replace_post_media(',
    );
    const before = 'WHERE id = p_post_id AND user_id = p_owner_user_id AND generation_id IS NULL )';
    const after = 'WHERE id = p_post_id AND user_id = p_owner_user_id AND generation_id IS NULL AND deleted_generation_id IS NULL )';
    expect(code(replaced)).toContain(after);
    expect(code(replaced).replace(after, before)).toBe(code(previous));
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) TO service_role;');
  });

  it("commits the NSFW copy of a deleted creation's public copy, and changes nothing else in the commit", () => {
    const replaced = functionText(sql, 'create or replace function public.commit_nsfw_media_private_copy(');
    const previous = functionText(
      readMigration('20260929120000_manual_nsfw_content.sql'),
      'create function public.commit_nsfw_media_private_copy(',
    );
    const before = "coalesce(starts_with(p_public_path,'showcase/'||v_post.generation_id::text||'/'),false)";
    const after = "coalesce(starts_with(p_public_path,'showcase/'||coalesce(v_post.generation_id,v_post.deleted_generation_id)::text||'/'),false)";
    expect(code(replaced)).toContain(after);
    expect(code(replaced).replace(after, before).replace('create or replace function', 'create function'))
      .toBe(code(previous));
    expect(sql).toContain('revoke all on function public.commit_nsfw_media_private_copy(uuid,uuid,text,text) from public,anon,authenticated;');
    expect(sql).toContain('grant execute on function public.commit_nsfw_media_private_copy(uuid,uuid,text,text) to service_role;');
  });
});
