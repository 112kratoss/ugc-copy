import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { POST_MEDIA_THUMB_FOLDER_PATTERN } from '@/lib/post-media-preview';
import { POST_MEDIA_PATH_COLUMNS } from '@/lib/post-media-storage';

// What the migration does to rows is held by
// supabase/tests/database/post_media_search_thumbs.test.sql. This file holds
// what a later re-creation, or an edit to this one, could quietly undo: that a
// thumb lives only beside a public preview, that its lifecycle follows that
// preview's through one trigger, that search's picture function is unchanged
// but for the thumb, and that the code's lists of a row's stored objects and
// its writers agree with the column.

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261123152813_post_media_search_thumbs.sql';
const PICTURE_MIGRATION = '20261115105944_search_content_suggestions.sql';
// A creation's public folder, as the revocation queue matches it.
const CREATION_FOLDER = '^showcase/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]';
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, '');
const read = (file: string) => withoutComments(readFileSync(join(migrationsDirectory, file), 'utf8'));
const statements = read(MIGRATION);
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** A function as one migration defines it, comments left out. */
function definitionIn(sql: string, name: string): string {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  const start = sql.search(pattern);
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  const fromDefinition = sql.slice(start);
  const closing = fromDefinition.search(/\n\$(?:function)?\$;/);
  expect(closing, `the definition of ${name} must close`).toBeGreaterThan(0);
  return fromDefinition.slice(0, closing);
}

function definers(name: string): string[] {
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'i');
  return migrationNames.filter((file) => pattern.test(read(file)));
}

describe('post media search thumbs migration', () => {
  it('runs after what it builds on, as one transaction with a lock timeout', () => {
    expect(migrationNames).toContain(MIGRATION);
    for (const earlier of [
      PICTURE_MIGRATION,
      '20261101100659_sweeps_queue_unrecorded_showcase_media.sql',
      '20261031174744_deleted_post_queues_its_media_rows.sql',
      '20260929120000_manual_nsfw_content.sql',
    ]) {
      expect(migrationNames, earlier).toContain(earlier);
      expect(MIGRATION > earlier, earlier).toBe(true);
    }
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    expect(statements.trim()).toMatch(/COMMIT;$/);
  });

  it('adds the column with the traversal guard every path column carries', () => {
    expect(statements).toContain('ADD COLUMN IF NOT EXISTS thumb_storage_path text;');
    const guard = statements.slice(
      statements.indexOf('ADD CONSTRAINT post_media_thumb_storage_path_safe_check'),
      statements.indexOf('VALIDATE CONSTRAINT post_media_thumb_storage_path_safe_check'),
    );
    for (const rule of ["thumb_storage_path NOT LIKE '%..%'", "thumb_storage_path !~ '[\\\\]'", "thumb_storage_path !~ '^/'", 'NOT VALID']) {
      expect(guard, rule).toContain(rule);
    }
    expect(statements).toContain('VALIDATE CONSTRAINT post_media_thumb_storage_path_safe_check;');
  });

  it('keeps a thumb in a creation\u2019s public folder beside a public preview, so no labelled post can carry one', () => {
    const check = squash(statements.slice(
      statements.indexOf('ADD CONSTRAINT post_media_thumb_beside_public_preview_check'),
      statements.indexOf('VALIDATE CONSTRAINT post_media_thumb_beside_public_preview_check'),
    ));
    expect(check).toContain(`thumb_storage_path IS NULL OR ( thumb_storage_path ~ '${CREATION_FOLDER}' AND preview_storage_path IS NOT NULL AND NOT starts_with(preview_storage_path, 'private-posts/') )`);
    expect(statements).toContain('VALIDATE CONSTRAINT post_media_thumb_beside_public_preview_check;');
    // The folder is the one the revocation queue takes, so every thumb a row
    // stops naming can be queued (review of #906), and the code holds the same rule.
    expect(read('20261101100659_sweeps_queue_unrecorded_showcase_media.sql')).toContain(`WHERE named.path ~ '${CREATION_FOLDER}'`);
    expect(POST_MEDIA_THUMB_FOLDER_PATTERN).toBe(CREATION_FOLDER);
  });

  it('drops a thumb its preview leaves behind and queues every thumb a row stops naming', () => {
    const trigger = definitionIn(statements, 'post_media_thumb_follows_its_preview');
    expect(trigger).toContain('SECURITY DEFINER');
    expect(trigger).toContain("SET search_path = ''");
    // A write that changes the preview without naming a thumb drops the thumb.
    expect(squash(trigger)).toContain(squash(`
      IF NEW.preview_storage_path IS DISTINCT FROM OLD.preview_storage_path
        AND NEW.thumb_storage_path IS NOT DISTINCT FROM OLD.thumb_storage_path THEN
        NEW.thumb_storage_path := NULL;
      END IF;`));
    // Whatever the row stops naming, by a write or by its delete, goes to the queue
    // whose job keeps what a serving post still names.
    expect(squash(trigger)).toContain(squash(`
      IF NEW.thumb_storage_path IS DISTINCT FROM OLD.thumb_storage_path THEN
        PERFORM public.queue_unrecorded_showcase_media(ARRAY[OLD.thumb_storage_path]);
      END IF;`));
    expect(squash(trigger)).toContain(squash(`
      IF TG_OP = 'DELETE' THEN
        PERFORM public.queue_unrecorded_showcase_media(ARRAY[OLD.thumb_storage_path]);
        RETURN OLD;
      END IF;`));
    expect(statements).toContain('ALTER FUNCTION public.post_media_thumb_follows_its_preview()\n  OWNER TO postgres;');
    expect(statements).toContain('REVOKE ALL ON FUNCTION public.post_media_thumb_follows_its_preview()\n  FROM PUBLIC, anon, authenticated, service_role;');
    expect(squash(statements)).toContain(squash(`
      CREATE TRIGGER post_media_thumb_follows_its_preview
      BEFORE UPDATE OF preview_storage_path, thumb_storage_path ON public.post_media
      FOR EACH ROW
      WHEN (OLD.thumb_storage_path IS NOT NULL)
      EXECUTE FUNCTION public.post_media_thumb_follows_its_preview();`));
    expect(squash(statements)).toContain(squash(`
      CREATE TRIGGER post_media_queue_deleted_thumb
      AFTER DELETE ON public.post_media
      FOR EACH ROW
      WHEN (OLD.thumb_storage_path IS NOT NULL)
      EXECUTE FUNCTION public.post_media_thumb_follows_its_preview();`));
    // The queue it hands a thumb to takes only a creation's public folder.
    expect(definers('queue_unrecorded_showcase_media')).toEqual(['20261101100659_sweeps_queue_unrecorded_showcase_media.sql']);
    expect(definers('post_media_thumb_follows_its_preview')).toEqual([MIGRATION]);
  });

  it('answers the thumb from search_post_picture, and nothing else in it changes', () => {
    expect(definers('search_post_picture').at(-1)).toBe(MIGRATION);
    const before = squash(definitionIn(read(PICTURE_MIGRATION), 'search_post_picture'));
    const after = squash(definitionIn(statements, 'search_post_picture')).replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');
    // The key is there only for a cover with a thumb: the answer for one
    // without, and every starter and typeahead answer carrying it, is unchanged.
    const added = [
      " || CASE WHEN cover.thumb_storage_path IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('thumb_path', cover.thumb_storage_path) END",
      'media.thumb_storage_path, ',
    ];
    for (const line of added) expect(after, line).toContain(line);
    expect(added.reduce((sql, line) => sql.replace(line, ''), after)).toBe(before);
    expect(statements).toContain('REVOKE ALL ON FUNCTION public.search_post_picture(uuid, uuid) FROM PUBLIC, anon, authenticated;');
    expect(statements).toContain('GRANT EXECUTE ON FUNCTION public.search_post_picture(uuid, uuid) TO service_role;');
    // The service reads the key the function answers.
    expect(source('src/lib/search-thumbnail.ts')).toContain('row.thumb_path');
  });

  it('is named wherever the code lists the stored objects of a post media row', () => {
    expect(POST_MEDIA_PATH_COLUMNS).toContain('thumb_storage_path');
    expect(source('src/lib/storage-orphans.ts')).toContain("columns: ['storage_path', 'preview_storage_path', 'display_storage_path', 'rendition_storage_path', 'teaser_storage_path', 'thumb_storage_path'],");
    // A takedown removes it with the rest.
    const moderation = source('src/lib/moderation-ops.ts');
    expect(moderation.slice(moderation.indexOf('const POST_MEDIA_PATH_COLUMNS = ['), moderation.indexOf('] as const;'))).toContain("'thumb_storage_path'");
    // A creation's cover repointed, or its post made private, retires it with the rest.
    const creation = source('src/lib/generation-post-media.ts');
    expect(creation).toContain('coverRow.thumb_storage_path,');
    expect(creation).toContain('row.teaser_storage_path, row.thumb_storage_path]');
    expect(creation).toContain('thumb_storage_path: null,');
    // Labelling never copies one private; it removes it from the public bucket.
    const labelling = source('src/lib/nsfw-media-security.ts');
    expect(labelling).toContain("const columns = ['storage_path', 'preview_storage_path', 'display_storage_path', 'rendition_storage_path', 'teaser_storage_path'] as const;");
    expect(labelling).toContain('thumb_storage_path, external_url');
    expect(labelling).toContain(".from('showcase_media').remove(thumbs)");
  });

  it('is made only by the writers that record it', () => {
    const sweep = source('src/lib/media-preview-repair.ts');
    expect(sweep.match(/withThumb: true/g)).toHaveLength(2);
    expect(sweep.match(/thumb_storage_path: preview\.thumbStoragePath \?\? null/g)).toHaveLength(2);
    // The publish and edit services store a post's own media in the private
    // bucket and record no thumb, so they never ask for one.
    for (const writer of ['src/lib/post-publish-service.ts', 'src/lib/post-update-service.ts']) {
      expect(source(writer), writer).not.toContain('withThumb');
    }
    const backfill = source('scripts/backfills/backfill-post-media-thumbs.ts');
    expect(backfill).toContain(".eq('preview_storage_path', row.preview_storage_path)");
    expect(backfill).toContain(".is('thumb_storage_path', null)");
    expect(backfill).toContain('parseBackfillExecutionMode');
    // Only covers in a creation's folder, of posts search can show (review of #906).
    expect(backfill).toContain('if (!canStorePostMediaThumb(naming)) {');
    for (const filter of [
      "posts!inner(id)",
      ".filter('preview_storage_path', 'match', POST_MEDIA_THUMB_FOLDER_PATTERN)",
      ".eq('posts.visibility', 'public')",
      ".eq('posts.review_status', 'visible')",
      ".is('posts.archived_at', null)",
      ".eq('posts.is_nsfw', false)",
      ".is('posts.tombstoned_at', null)",
    ]) {
      // Both the count and the page read hold it.
      expect(backfill.split(filter).length - 1, filter).toBe(2);
    }
  });
});
