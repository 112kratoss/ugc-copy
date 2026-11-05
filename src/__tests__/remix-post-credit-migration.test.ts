import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readMigration(name: string) {
  return readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
}

function functionText(sql: string, start: string) {
  const from = sql.indexOf(start);
  expect(from, `${start} is in the migration`).toBeGreaterThanOrEqual(0);
  return sql.slice(from, sql.indexOf('$$;', from) + 3);
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const withoutComments = (sql: string) => sql.replace(/^\s*--.*$/gm, '');

function expectLockTimeoutTransaction(sql: string) {
  const body = withoutComments(sql).trim();
  expect(body.startsWith("BEGIN;\nSET LOCAL lock_timeout = '5s';")).toBe(true);
  expect(body.endsWith('COMMIT;')).toBe(true);
}

/**
 * The behaviour is asserted by pgTAP (remix_post_credit.test.sql). This pins the
 * migrations' shape: who writes the credit and when it stays, what the backfill
 * touches, and that the block trigger keeps every earlier unnaming.
 */
describe('remix posts carry their credit', () => {
  const sql = readMigration('20261105150143_remix_posts_carry_their_credit.sql');
  const credit = functionText(sql, 'CREATE OR REPLACE FUNCTION public.remix_credit_for_generation(');
  const trigger = functionText(sql, 'CREATE OR REPLACE FUNCTION public.copy_generation_remix_credit_to_post()');

  it('runs in a transaction of its own that gives up on a lock, and fills nothing', () => {
    expectLockTimeoutTransaction(sql);
    expect(withoutComments(sql)).not.toMatch(/\bUPDATE public\.posts\b|backfill/i);
  });

  it('adds the three ids as plain references that deleting nothing rewrites', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS remix_parent_post_id uuid,/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS remix_parent_user_id uuid,/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS remix_origin_user_id uuid;/);
    expect(withoutComments(sql)).not.toMatch(/REFERENCES/);
  });

  it('indexes a post\'s remixes newest first, and only the posts that are remixes', () => {
    expect(normalize(sql)).toContain(normalize(`
      CREATE INDEX IF NOT EXISTS posts_remix_parent_post_idx
        ON public.posts (remix_parent_post_id, created_at DESC, id DESC)
        WHERE remix_parent_post_id IS NOT NULL;`));
  });

  it('credits the post the ledger names, walking back through the maker\'s own creations only', () => {
    expect(credit).toMatch(/FROM public\.completed_post_remixes AS remix\s+JOIN public\.posts AS p ON p\.id = remix\.post_id/);
    expect(credit).toMatch(/v_source_user_id NOT IN \(SELECT public\.linked_account_ids\(v_run_user_id\)\)/);
    expect(credit).toMatch(/v_steps >= 20/);
    // The original: the post remixed's own, else its creator; with no post, the chain's first creation's maker.
    expect(credit).toContain('coalesce(v_parent_origin_user_id, v_parent_user_id)');
    expect(credit).toContain('coalesce(owner.merged_into_user_id, origin.user_id)');
    expect(credit).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.remix_credit_for_generation(uuid) FROM PUBLIC, anon, authenticated;');
  });

  it('writes the credit when a post is made from its creation, and never changes or clears one after', () => {
    expect(normalize(sql)).toContain(normalize(`
      CREATE TRIGGER posts_copy_remix_credit
      BEFORE INSERT OR UPDATE OF generation_id, remix_parent_post_id, remix_parent_user_id, remix_origin_user_id
      ON public.posts
      FOR EACH ROW EXECUTE FUNCTION public.copy_generation_remix_credit_to_post();`));
    expect(normalize(trigger)).toContain(normalize(`
      IF TG_OP = 'UPDATE'
        AND num_nonnulls(OLD.remix_parent_post_id, OLD.remix_parent_user_id, OLD.remix_origin_user_id) > 0
        AND (NEW.generation_id IS NULL OR NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id) THEN
        NEW.remix_parent_post_id := OLD.remix_parent_post_id;`));
    expect(trigger).toContain('v_credit.parent_post_id IS DISTINCT FROM NEW.id');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.copy_generation_remix_credit_to_post() FROM PUBLIC, anon, authenticated;');
  });
});

describe('the remix credit backfill', () => {
  const sql = readMigration('20261105150200_remix_post_credit_backfill.sql');
  const backfill = functionText(sql, 'CREATE OR REPLACE FUNCTION public.backfill_remix_post_credit()');

  it('runs after the schema, in a transaction of its own that gives up on a lock', () => {
    expectLockTimeoutTransaction(sql);
    expect('20261105150200' > '20261105150143').toBe(true);
    expect(sql).toContain('SELECT public.backfill_remix_post_credit();');
  });

  it('asks only posts with no credit whose creation has one, oldest first, clear of the deletion freeze', () => {
    expect(backfill).toMatch(/p\.remix_parent_post_id IS NULL\s+AND p\.remix_parent_user_id IS NULL\s+AND p\.remix_origin_user_id IS NULL/);
    expect(backfill).toContain('EXISTS (SELECT 1 FROM public.remix_credit_for_generation(p.generation_id))');
    expect(backfill).toContain('NOT public.is_account_deletion_requested(p.user_id)');
    expect(backfill).toContain('ORDER BY p.created_at, p.id');
    // The trigger answers the update for a post with no credit yet.
    expect(backfill).toMatch(/UPDATE public\.posts\s+SET remix_parent_post_id = NULL\s+WHERE id = v_post\.id;/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.backfill_remix_post_credit() FROM PUBLIC, anon, authenticated;');
  });
});

describe('remix alerts are unnamed across blocks and deletion', () => {
  const sql = readMigration('20261105150333_unname_remix_alerts_across_blocks_and_deletion.sql');
  const previous = readMigration('20261020072851_unname_follow_alerts_across_blocks_and_deletion.sql');
  const block = functionText(sql, 'CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()');
  const previousBlock = functionText(previous, 'CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()');

  it('locks the inbox for its triggers without locking out its reads', () => {
    expectLockTimeoutTransaction(sql);
    expect(sql).toContain('LOCK TABLE public.mobile_notifications IN SHARE ROW EXCLUSIVE MODE;');
    expect(withoutComments(sql)).not.toMatch(/DROP TRIGGER/);
  });

  it('unnames a remix alert written across a block and one whose remixer is deleted', () => {
    expect(normalize(sql)).toContain(normalize(`
      CREATE OR REPLACE TRIGGER mobile_notifications_unname_remix_alert_across_block
      BEFORE INSERT ON public.mobile_notifications
      FOR EACH ROW
      WHEN (NEW.type = 'post_remixed' AND NEW.actor_user_id IS NOT NULL)`));
    expect(normalize(sql)).toContain(normalize(`
      CREATE OR REPLACE TRIGGER mobile_notifications_unname_remix_alert_of_deleted_remixer
      BEFORE UPDATE OF actor_user_id ON public.mobile_notifications`));
    // The pair's lock, as the follow and sale alerts take it.
    expect(sql).toContain("'follow-block:' || least(NEW.user_id, NEW.actor_user_id)::text");
  });

  it('keeps everything the block trigger did before, and adds the remix alerts', () => {
    // Every statement of 20261020072851's body, as it was.
    const statements = withoutComments(previousBlock.slice(previousBlock.indexOf('DELETE FROM public.follows'), previousBlock.indexOf('RETURN NEW;')))
      .split(';')
      .map(normalize)
      .filter(Boolean);
    expect(statements).toHaveLength(4);
    for (const statement of statements) expect(normalize(withoutComments(block))).toContain(statement);
    expect(block).toContain("named.type = 'post_remixed'");
    expect(block).toContain('public.unnamed_remix_alert_words(named.title, named.deep_link, named.object_id)');
  });
});
