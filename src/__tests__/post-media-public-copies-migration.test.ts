import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ORPHAN_SKIPPED_TABLES } from '@/lib/storage-orphans';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const strip = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const file = files.find((name) => name.endsWith('_post_media_public_copies.sql'));
const sql = file ? strip(readFileSync(path.join(MIGRATIONS, file), 'utf8')) : '';

/** One function's definition, from its CREATE line to the end of its body. */
function definition(signature: string): string {
  const start = sql.indexOf(signature);
  if (start < 0) return '';
  const end = sql.indexOf('$$;', start);
  return sql.slice(start, end < 0 ? undefined : end);
}

/**
 * pgTAP (post_media_public_copies.test.sql) runs every transition against a
 * replayed database. This pins what a review reads: who may be served a copy,
 * every write that takes the copies back, the order an object may exist in,
 * and who may call what.
 */
describe('post media public copies migration', () => {
  it('is the newest migration touching post_media copies, and records copies on the row', () => {
    expect(file).toBeDefined();
    expect(sql).toContain(
      "ALTER TABLE public.post_media ADD COLUMN public_copy_paths text[] NOT NULL DEFAULT '{}'::text[];",
    );
  });

  it('lets a row record only the public twin of its own private paths', () => {
    expect(sql).toContain('ADD CONSTRAINT post_media_public_copy_paths_check CHECK ( public_copy_paths <@ ARRAY[');
    for (const column of ['storage_path', 'preview_storage_path', 'display_storage_path', 'rendition_storage_path', 'teaser_storage_path']) {
      expect(sql).toContain(
        `CASE WHEN starts_with(${column}, 'private-posts/' || post_id::text || '/') THEN 'public-posts/' || substr(${column}, 15) END`,
      );
    }
  });

  it('serves copies only of a post anyone signed out may read, the rule /api/media signs by', () => {
    const allowed = definition('CREATE FUNCTION public.post_media_public_copies_allowed(p_post_id uuid)');
    for (const condition of [
      "post.visibility = 'public'",
      'post.archived_at IS NULL',
      "post.review_status = 'visible'",
      'post.tombstoned_at IS NULL',
      'NOT post.is_nsfw',
      "owner.identity_state = 'active'",
    ]) {
      expect(allowed).toContain(condition);
    }
    // The same signed-out rule can_read_private_post_media applies.
    const readRule = strip(readFileSync(
      path.join(MIGRATIONS, '20261030151942_post_keeps_its_deleted_creation_folder.sql'),
      'utf8',
    ));
    expect(readRule).toContain("p.visibility in ('public','unlisted') and p.archived_at is null and p.review_status='visible' and p.tombstoned_at is null and public.can_read_nsfw_post(p.id,p_viewer_id)");
  });

  it('takes the copies back in the transaction of every write that ends public reading', () => {
    expect(sql).toContain(
      'CREATE TRIGGER posts_revoke_media_public_copies AFTER UPDATE OF visibility, archived_at, review_status, tombstoned_at, is_nsfw, user_id ON public.posts',
    );
    expect(sql).toContain('CREATE TRIGGER post_media_queue_deleted_public_copies AFTER DELETE ON public.post_media');
    expect(sql).toContain(
      'CREATE TRIGGER post_media_prune_public_copies BEFORE UPDATE OF storage_path, preview_storage_path, display_storage_path, rendition_storage_path, teaser_storage_path, post_id ON public.post_media',
    );
    expect(sql).toContain('CREATE TRIGGER profiles_revoke_media_public_copies AFTER UPDATE OF identity_state ON public.profiles');

    const revoke = definition('CREATE FUNCTION public.revoke_post_media_public_copies(p_post_id uuid, p_reason text)');
    expect(revoke).toContain('INSERT INTO public.post_media_public_copy_queue');
    expect(revoke).toContain("SET public_copy_paths = '{}'::text[]");
    // A copy still being made is due at once too.
    expect(revoke).toContain('SET next_attempt_at = now() WHERE post_id = p_post_id AND next_attempt_at > now()');
  });

  it('refuses any transaction that leaves a copy recorded on a post nobody signed out may read', () => {
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER z_posts_media_public_copies_allowed AFTER UPDATE OF visibility, archived_at, review_status, tombstoned_at, is_nsfw, user_id ON public.posts DEFERRABLE INITIALLY DEFERRED',
    );
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER z_post_media_public_copies_allowed AFTER INSERT OR UPDATE OF public_copy_paths ON public.post_media DEFERRABLE INITIALLY DEFERRED',
    );
    expect(definition('CREATE FUNCTION public.assert_post_media_public_copies_allowed()'))
      .toContain("RAISE EXCEPTION 'POST_MEDIA_PUBLIC_COPY_NOT_ALLOWED'");
  });

  it('queues a copy before its object exists and records it only once Storage holds it at the source\'s size', () => {
    const begin = definition('CREATE FUNCTION public.begin_post_media_public_copies(p_post_id uuid)');
    expect(begin).toContain('PERFORM 1 FROM public.posts WHERE id = p_post_id FOR UPDATE;');
    expect(begin).toContain('IF NOT FOUND OR NOT public.post_media_public_copies_allowed(p_post_id) THEN RETURN;');
    expect(begin).toContain("INSERT INTO public.post_media_public_copy_queue AS queued (public_path, post_id, reason, next_attempt_at) SELECT wanted.public_object, p_post_id, 'copying'");

    const commit = definition('CREATE FUNCTION public.commit_post_media_public_copies(p_post_id uuid, p_copy_paths text[])');
    expect(commit).toContain('SELECT post.user_id INTO v_owner_id FROM public.posts AS post WHERE post.id = p_post_id FOR UPDATE;');
    // Serialized with the owner leaving the active state, which holds no post lock.
    expect(commit).toContain('PERFORM 1 FROM public.profiles WHERE id = v_owner_id FOR SHARE; v_allowed := public.post_media_public_copies_allowed(p_post_id);');
    // A sweep that replaced the source meanwhile left nothing recording it: it stays queued.
    expect(commit).toContain('IF EXISTS ( SELECT 1 FROM public.post_media AS media WHERE media.post_id = p_post_id AND v_copy = ANY(media.public_copy_paths) ) THEN DELETE FROM public.post_media_public_copy_queue WHERE public_path = v_copy;');
    expect(commit).toContain("WHERE objects.bucket_id = 'post_media' AND objects.name = v_source;");
    expect(commit).toContain("WHERE objects.bucket_id = 'showcase_media' AND objects.name = v_copy;");
    expect(commit).toContain('IF v_source_size > 0 AND v_copy_size = v_source_size THEN');
    // A copy not recorded stays queued, due now, its claim let go.
    expect(commit).toContain("VALUES (v_copy, p_post_id, 'copy_refused', now()) ON CONFLICT (public_path) DO UPDATE SET reason = 'copy_refused', next_attempt_at = now(), claimed_at = NULL, claim_token = NULL;");
  });

  it('hands a removal a claim token under the post\'s lock and never drops a served copy', () => {
    const claim = definition('CREATE FUNCTION public.claim_post_media_public_copy_removal(p_copy_path text)');
    expect(claim).toContain('PERFORM 1 FROM public.posts WHERE id = v_post_id FOR UPDATE;');
    // The rows recording it are locked, so a sweep dropping it queues it again after the delete.
    expect(claim).toContain('WHERE media.post_id = v_post_id AND p_copy_path = ANY(media.public_copy_paths) FOR UPDATE; IF FOUND THEN DELETE');
    expect(claim).toContain("RETURN jsonb_build_object('outcome', 'served');");
    expect(definition('CREATE FUNCTION public.finish_post_media_public_copy_removal(p_copy_path text, p_claim_token uuid)'))
      .toContain('AND claim_token = p_claim_token');
  });

  it('keeps the queue and every function off the Data API but for the service role', () => {
    expect(sql).toContain('ALTER TABLE public.post_media_public_copy_queue ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.post_media_public_copy_queue FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).toContain('GRANT SELECT ON TABLE public.post_media_public_copy_queue TO service_role;');
    for (const signature of [
      'post_media_public_copy_path(uuid, text)',
      'post_media_public_copies_allowed(uuid)',
      'begin_post_media_public_copies(uuid)',
      'commit_post_media_public_copies(uuid, text[])',
      'claim_post_media_public_copy_removal(text)',
      'finish_post_media_public_copy_removal(text, uuid)',
      'reschedule_post_media_public_copy_removal(text, uuid, text)',
      'list_post_media_public_copy_candidates(integer, boolean)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    for (const signature of [
      'revoke_post_media_public_copies(uuid, text)',
      'revoke_post_media_public_copies_with_post()',
      'prune_post_media_public_copies()',
      'queue_deleted_post_media_public_copies()',
      'revoke_post_media_public_copies_with_owner()',
      'assert_post_media_public_copies_allowed()',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
    }
    expect(sql).not.toMatch(/GRANT [^;]* TO (anon|authenticated)/u);
  });

  it('runs every SECURITY DEFINER function with an empty search_path', () => {
    const definers = sql.split('CREATE FUNCTION ').slice(1).filter((body) => body.includes('SECURITY DEFINER'));
    expect(definers.length).toBeGreaterThanOrEqual(12);
    for (const body of definers) expect(body).toContain("SET search_path = ''");
  });

  it('is classified for the orphan listing', () => {
    expect(ORPHAN_SKIPPED_TABLES.post_media_public_copy_queue).toBeDefined();
  });
});
