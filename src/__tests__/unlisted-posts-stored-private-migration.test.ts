import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_NAME = '20261017144307_store_unlisted_posts_as_private.sql';
const MIGRATION_PATH = path.join(process.cwd(), 'supabase/migrations', MIGRATION_NAME);

/**
 * Product decision 12 (2026-10-17): a post is public or private. The API maps
 * a requested unlisted to private before it writes; this migration holds
 * every other writer to the same rule and moves any stored unlisted post.
 * The behaviour is asserted by pgTAP (unlisted_posts_stored_private.test.sql);
 * this pins the migration's shape.
 */
describe('store unlisted posts as private', () => {
  const sql = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

  it('exists under its UTC stamp', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('rewrites a requested unlisted to private before the row is stored', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.store_unlisted_post_as_private()\n'
      + 'RETURNS trigger\n'
      + 'LANGUAGE plpgsql\n'
      + "SET search_path = ''\n"
      + 'AS $$\n'
      + 'BEGIN\n'
      + "  IF NEW.visibility = 'unlisted' THEN\n"
      + "    NEW.visibility := 'private';\n"
      + '  END IF;\n'
      + '  RETURN NEW;\n'
      + 'END;\n'
      + '$$;',
    );
    // It only relabels the row it is given: no definer rights needed.
    expect(sql).not.toContain('SECURITY DEFINER');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.store_unlisted_post_as_private()\n  FROM PUBLIC, anon, authenticated;',
    );
  });

  it('runs on every insert and on every update that writes the visibility', () => {
    expect(sql).toContain(
      'CREATE TRIGGER a_posts_store_unlisted_as_private\n'
      + 'BEFORE INSERT OR UPDATE OF visibility ON public.posts\n'
      + 'FOR EACH ROW\n'
      + 'EXECUTE FUNCTION public.store_unlisted_post_as_private();',
    );
  });

  it('is named to fire before every other BEFORE trigger on posts', () => {
    // Same-timing triggers fire in name order (byte order). The NSFW revision
    // trigger compares the visibility it is given with the stored one, so it
    // has to be given the private the row will hold, not the unlisted asked for.
    const otherBeforeTriggers = [
      'posts_advance_nsfw_revision',
      'posts_delete_feed_events_before_delete',
      'posts_freeze_for_account_deletion',
      'posts_reject_sold_delete',
      'posts_set_updated_at',
      'posts_sync_purchase_moderation_delete',
    ];
    const ordered = ['a_posts_store_unlisted_as_private', ...otherBeforeTriggers]
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    expect(ordered[0]).toBe('a_posts_store_unlisted_as_private');
  });

  it('moves any stored unlisted post to private after the trigger exists', () => {
    const update = sql.indexOf("UPDATE public.posts\nSET visibility = 'private'\nWHERE visibility = 'unlisted';");
    expect(update).toBeGreaterThan(sql.indexOf('CREATE TRIGGER a_posts_store_unlisted_as_private'));
  });

  it('leaves the CHECK, the reads and marketplace assets alone', () => {
    // Old values stay legal, so every read that still accepts unlisted keeps working.
    expect(sql).not.toMatch(/ALTER TABLE public\.posts/i);
    expect(sql).not.toMatch(/CONSTRAINT/i);
    // A marketplace asset's own `unlisted` status is a different thing.
    expect(sql).not.toContain('marketplace_assets');
  });
});
