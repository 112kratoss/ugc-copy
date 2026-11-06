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
  const sql = readMigration('20261105175340_remix_posts_carry_their_credit.sql');
  const credit = functionText(sql, 'CREATE OR REPLACE FUNCTION public.remix_credit_for_generation(');
  const runCredit = functionText(sql, 'CREATE OR REPLACE FUNCTION public.remix_credit_for_run(');
  const recordRun = functionText(sql, 'CREATE OR REPLACE FUNCTION public.record_generation_remix_credit()');
  const trigger = functionText(sql, 'CREATE OR REPLACE FUNCTION public.copy_generation_remix_credit_to_post()');

  it('runs in a transaction of its own that gives up on a lock, and fills nothing', () => {
    expectLockTimeoutTransaction(sql);
    expect(withoutComments(sql)).not.toMatch(/\bUPDATE public\.(posts|generations)\b|backfill/i);
  });

  it('adds the three ids to posts, then creations, as plain references that deleting nothing rewrites', () => {
    for (const table of ['posts', 'generations']) {
      expect(normalize(sql)).toContain(normalize(`
        ALTER TABLE public.${table}
          ADD COLUMN IF NOT EXISTS remix_parent_post_id uuid,
          ADD COLUMN IF NOT EXISTS remix_parent_user_id uuid,
          ADD COLUMN IF NOT EXISTS remix_origin_user_id uuid;`));
    }
    // posts first, then generations: the edit path's order.
    expect(sql.indexOf('ALTER TABLE public.posts')).toBeLessThan(sql.indexOf('ALTER TABLE public.generations'));
    expect(withoutComments(sql)).not.toMatch(/REFERENCES/);
  });

  it('indexes a post\'s remixes newest first, and only the posts that are remixes', () => {
    expect(normalize(sql)).toContain(normalize(`
      CREATE INDEX IF NOT EXISTS posts_remix_parent_post_idx
        ON public.posts (remix_parent_post_id, created_at DESC, id DESC)
        WHERE remix_parent_post_id IS NOT NULL;`));
  });

  it('reads what a creation recorded, the ledger winning over a record that names no post, walking back through the maker\'s own creations only', () => {
    expect(normalize(credit)).toContain(normalize(`
      IF num_nonnulls(v_run.remix_parent_post_id, v_run.remix_parent_user_id, v_run.remix_origin_user_id) > 0
        AND (v_run.remix_parent_post_id IS NOT NULL OR NOT v_ledger) THEN`));
    expect(credit).toMatch(/FROM public\.completed_post_remixes AS remix\s+JOIN public\.posts AS p ON p\.id = remix\.post_id/);
    // A NULL maker never walks on into someone else's creation (NOT IN over a NULL row is NULL).
    expect(credit).toContain('EXIT WHEN v_run.source_generation_id IS NULL OR v_run.user_id IS NULL OR v_steps >= 20;');
    expect(credit).toContain('SELECT 1 FROM public.linked_account_ids(v_run.user_id) AS linked(id) WHERE linked.id = v_source_user_id');
    expect(credit).not.toMatch(/NOT IN \(SELECT public\.linked_account_ids/);
    // A run from someone else's creation with no ledger row yet (still running) takes that creation's public post.
    expect(credit).toContain('public.remix_credit_from_source_post(v_run.source_generation_id)');
    expect(credit).toMatch(/v_steps >= 20/);
    // The original: the post remixed's own, else its creation's, else its creator; with no post, the chain's first creation's maker.
    expect(credit).toContain('coalesce(p.remix_origin_user_id, parent_run.remix_origin_user_id, p.user_id)');
    expect(credit).toContain('coalesce(owner.merged_into_user_id, origin.user_id)');
    expect(credit).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.remix_credit_for_generation(uuid) FROM PUBLIC, anon, authenticated;');
  });

  it('records a run\'s credit when it is made: its own source\'s, else the public post it remixed', () => {
    const own = runCredit.indexOf('SELECT 1 FROM public.linked_account_ids(p_user_id) AS linked(id) WHERE linked.id = v_source.user_id');
    expect(own).toBeGreaterThan(0);
    expect(runCredit.slice(own)).toMatch(/RETURN QUERY SELECT \* FROM public\.remix_credit_for_generation\(v_source\.id\);/);
    expect(runCredit).toContain('public.remix_credit_from_source_post(v_source.id)');
    // Posted by its maker, or by the account a guest maker linked to, as the remix ledger finds it.
    const sourcePost = functionText(sql, 'CREATE OR REPLACE FUNCTION public.remix_credit_from_source_post(');
    expect(normalize(sourcePost)).toContain(normalize(`
      AND p.visibility = 'public'
      AND (
        p.user_id = source.user_id
        OR EXISTS (
          SELECT 1
          FROM public.profiles AS owner
          WHERE owner.id = source.user_id
            AND owner.merged_into_user_id = p.user_id
        )
      )`));
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.remix_credit_from_source_post(uuid) FROM PUBLIC, anon, authenticated;');
    expect(runCredit).toMatch(/LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.remix_credit_for_run(uuid, uuid) FROM PUBLIC, anon, authenticated;');
  });

  it('keeps a creation\'s credit through every update but a new source, its source\'s deletion included', () => {
    expect(normalize(sql)).toContain(normalize(`
      CREATE TRIGGER generations_record_remix_credit
      BEFORE INSERT OR UPDATE OF source_generation_id, remix_parent_post_id, remix_parent_user_id, remix_origin_user_id
      ON public.generations
      FOR EACH ROW EXECUTE FUNCTION public.record_generation_remix_credit();`));
    expect(normalize(recordRun)).toContain(normalize(`
      IF TG_OP = 'UPDATE'
        AND (NEW.source_generation_id IS NULL OR NEW.source_generation_id IS NOT DISTINCT FROM OLD.source_generation_id) THEN
        IF num_nonnulls(OLD.remix_parent_post_id, OLD.remix_parent_user_id, OLD.remix_origin_user_id) > 0 THEN
          NEW.remix_parent_post_id := OLD.remix_parent_post_id;`));
    expect(recordRun).toContain('public.remix_credit_for_run(NEW.user_id, NEW.source_generation_id)');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.record_generation_remix_credit() FROM PUBLIC, anon, authenticated;');
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
  const sql = readMigration('20261105175341_remix_post_credit_backfill.sql');
  const backfill = functionText(sql, 'CREATE OR REPLACE FUNCTION public.backfill_remix_post_credit()');

  it('runs after the schema, in a transaction of its own that gives up on a lock', () => {
    expectLockTimeoutTransaction(sql);
    expect('20261105175341' > '20261105175340').toBe(true);
    expect(sql).toContain('SELECT public.backfill_remix_post_credit();');
  });

  it('fills creations first, oldest first, and writes only those with a credit to take', () => {
    expect(backfill.indexOf('FROM public.generations AS g')).toBeLessThan(backfill.indexOf('FROM public.posts AS p'));
    expect(backfill).toMatch(/g\.remix_parent_post_id IS NULL\s+AND g\.remix_parent_user_id IS NULL\s+AND g\.remix_origin_user_id IS NULL/);
    expect(backfill).toContain('ORDER BY g.created_at, g.id');
    expect(backfill).toMatch(/IF EXISTS \(SELECT 1 FROM public\.remix_credit_for_generation\(v_run\.id\)\) THEN\s+BEGIN\s+UPDATE public\.generations\s+SET remix_parent_post_id = NULL\s+WHERE id = v_run\.id;/);
  });

  it('then asks only posts with no credit whose creation has one, oldest first, clear of the deletion freeze', () => {
    expect(backfill).toMatch(/p\.remix_parent_post_id IS NULL\s+AND p\.remix_parent_user_id IS NULL\s+AND p\.remix_origin_user_id IS NULL/);
    expect(backfill).toContain('EXISTS (SELECT 1 FROM public.remix_credit_for_generation(p.generation_id))');
    expect(backfill).toContain('NOT public.is_account_deletion_requested(p.user_id)');
    expect(backfill).toContain('ORDER BY p.created_at, p.id');
    // The trigger answers the update for a post with no credit yet; a deletion
    // begun mid-run skips its post instead of failing the release.
    expect(backfill).toMatch(/BEGIN\s+UPDATE public\.posts\s+SET remix_parent_post_id = NULL\s+WHERE id = v_post\.id;\s+EXCEPTION WHEN object_not_in_prerequisite_state OR deadlock_detected OR lock_not_available THEN/);
    // A row an edit holds (it takes a post, then its creation) is skipped, not the release failed.
    expect(backfill).toMatch(/EXCEPTION WHEN deadlock_detected OR lock_not_available THEN/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.backfill_remix_post_credit() FROM PUBLIC, anon, authenticated;');
  });
});

describe('remix alerts are unnamed across blocks and deletion', () => {
  const sql = readMigration('20261105175342_unname_remix_alerts_across_blocks_and_deletion.sql');
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

describe('remix alerts follow the remixer\'s handle', () => {
  const sql = readMigration('20261105175343_remix_alerts_follow_the_remixers_handle.sql');
  const alertsSql = readMigration('20261105175342_unname_remix_alerts_across_blocks_and_deletion.sql');
  const words = functionText(alertsSql, 'CREATE OR REPLACE FUNCTION public.renamed_remix_alert_words(');
  const rename = functionText(sql, 'CREATE OR REPLACE FUNCTION public.rename_remix_alerts_of_renamed_remixer()');

  it('runs after the alerts\' own migration, in a transaction of its own that locks profiles only', () => {
    expectLockTimeoutTransaction(sql);
    expect('20261105175343' > '20261105175342').toBe(true);
    expect(withoutComments(sql)).not.toMatch(/LOCK TABLE|DROP TRIGGER/);
    expect(withoutComments(sql)).not.toMatch(/ON public\.mobile_notifications\b/);
  });

  it('renames an account\'s remix alerts when its handle changes, from each alert\'s own row', () => {
    expect(normalize(sql)).toContain(normalize(`
      CREATE OR REPLACE TRIGGER profiles_rename_remix_alerts
      AFTER UPDATE OF username ON public.profiles
      FOR EACH ROW
      WHEN (OLD.username IS DISTINCT FROM NEW.username)
      EXECUTE FUNCTION public.rename_remix_alerts_of_renamed_remixer();`));
    // No self-join: a block unnaming the row at the same moment is read again.
    expect(rename).not.toMatch(/FROM public\.mobile_notifications AS named/);
    expect(normalize(rename)).toContain(normalize(`
      WHERE alert.actor_user_id = NEW.id
        AND alert.type = 'post_remixed'
        AND alert.title ~ '^@\\S+ (remixed your post|posted a remix of your post)$';`));
  });

  it('gives a handle profiles would refuse, or none, the words that name no one', () => {
    expect(words).toContain("v_handle !~ '^[a-z0-9-]{3,24}$'");
    expect(words).toContain('public.unnamed_remix_alert_words(p_title, p_deep_link, p_object_id)');
    const usernameRule = readMigration('20260320120000_creator_profiles_and_remix_lineage.sql');
    expect(usernameRule).toContain("username ~ '^[a-z0-9-]{3,24}$'");
    expect(alertsSql).toContain('REVOKE ALL ON FUNCTION public.renamed_remix_alert_words(text, text, text, text) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.rename_remix_alerts_of_renamed_remixer() FROM PUBLIC, anon, authenticated;');
  });

  // A rename between the server's read of the handle and the insert would leave
  // a handle anyone may claim: the insert names the remixer as they are, with
  // their row held so a rename waits for it.
  it('names a new alert by the handle its remixer has as it is written, their row held', () => {
    const insertTrigger = functionText(alertsSql, 'CREATE OR REPLACE FUNCTION public.unname_remix_alert_that_cannot_name()');
    expect(normalize(insertTrigger)).toContain(normalize(`
      SELECT remixer.username INTO v_handle
      FROM public.profiles AS remixer
      WHERE remixer.id = NEW.actor_user_id
      FOR SHARE;`));
    expect(insertTrigger).toContain('public.renamed_remix_alert_words(NEW.title, NEW.deep_link, NEW.object_id, v_handle)');
    // The words are defined before the trigger function that reads them.
    expect(alertsSql.indexOf('CREATE OR REPLACE FUNCTION public.renamed_remix_alert_words('))
      .toBeLessThan(alertsSql.indexOf('CREATE OR REPLACE FUNCTION public.unname_remix_alert_that_cannot_name()'));
  });
});
