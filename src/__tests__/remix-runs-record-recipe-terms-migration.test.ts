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

const SELF_REMIX_EXCLUSION = /\n\s+AND NEW\.user_id NOT IN \(SELECT public\.linked_account_ids\(p\.user_id\)\);/;

/** Both files run in a transaction of their own that gives up on a lock after five seconds. */
function expectLockTimeoutTransaction(sql: string) {
  const body = sql.replace(/^--.*$/gm, '').trim();
  expect(body.startsWith("BEGIN;\nSET LOCAL lock_timeout = '5s';")).toBe(true);
  expect(body.endsWith('COMMIT;')).toBe(true);
}

/**
 * The behaviour is asserted by pgTAP (remix_runs_record_recipe_terms.test.sql).
 * This pins the migrations' shape: who writes the columns, what a run inherits
 * and keeps, that the remix credit's only change is the self-remix rule, and
 * how the backfill stays clear of the deletion freeze.
 */
describe('remix runs record their recipe terms', () => {
  const sql = readMigration('20261105123244_remix_runs_record_their_recipe_terms.sql');
  const terms = functionText(sql, 'CREATE OR REPLACE FUNCTION public.remix_terms_for(');
  const trigger = functionText(sql, 'CREATE OR REPLACE FUNCTION public.record_generation_remix_terms()');
  const credit = functionText(sql, 'CREATE OR REPLACE FUNCTION public.record_completed_post_remix()');

  it('runs in a transaction of its own that gives up on a lock, posts locked before generations', () => {
    expectLockTimeoutTransaction(sql);
    expect(sql.indexOf('ALTER TABLE public.posts')).toBeLessThan(sql.indexOf('ALTER TABLE public.generations'));
    // The rows written before it are the backfill's (20261105132114), outside these locks.
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/backfill|DELETE FROM/i);
  });

  it('adds the columns, the two ids as plain references that deleting nothing rewrites', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS remix_recipe_mode text,/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS remix_recipe_bundle_id uuid,/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS remix_origin_generation_id uuid;/);
    expect(sql).not.toMatch(/REFERENCES/);
    expect(sql).not.toMatch(/CREATE INDEX/);
    expect(sql).toMatch(/CHECK \(remix_recipe_mode IS NULL OR remix_recipe_mode IN \('free', 'paid'\)\)/);
  });

  it('writes the terms on insert and on a new source, and keeps them when the source is cleared', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER generations_record_remix_terms\s+BEFORE INSERT OR UPDATE OF source_generation_id ON public\.generations\s+FOR EACH ROW EXECUTE FUNCTION public\.record_generation_remix_terms\(\);/,
    );
    expect(normalize(trigger)).toContain(normalize(`
      IF TG_OP = 'UPDATE'
        AND (NEW.source_generation_id IS NULL OR NEW.source_generation_id IS NOT DISTINCT FROM OLD.source_generation_id) THEN
        NEW.remix_recipe_mode := OLD.remix_recipe_mode;
        NEW.remix_recipe_bundle_id := OLD.remix_recipe_bundle_id;
        NEW.remix_origin_generation_id := OLD.remix_origin_generation_id;
        RETURN NEW;
      END IF;
    `));
    const cleared = trigger.indexOf('NEW.remix_recipe_mode := NULL;');
    expect(cleared).toBeGreaterThan(0);
    expect(cleared).toBeLessThan(trigger.indexOf('public.remix_terms_for(NEW.user_id, NEW.source_generation_id)'));
  });

  it('lets a run from the caller\'s own creation inherit its source\'s terms', () => {
    expect(terms).toMatch(/IF v_source\.user_id IN \(SELECT public\.linked_account_ids\(p_user_id\)\) THEN/);
    expect(terms).toMatch(
      /RETURN QUERY SELECT v_source\.remix_recipe_mode, v_source\.remix_recipe_bundle_id,\s+v_source\.remix_origin_generation_id;/,
    );
  });

  it('makes a remix of someone else\'s post paid by a paid purchase of its recipe or a paid source', () => {
    expect(terms).toMatch(/v_bought_paid := public\.remix_source_bought_paid\(p_user_id, v_source\.id\);/);
    expect(terms).toMatch(
      /CASE WHEN v_bought_paid OR v_source\.remix_recipe_mode = 'paid' THEN 'paid' ELSE 'free' END/,
    );
    expect(terms).toMatch(/coalesce\(v_source\.remix_origin_generation_id, v_source\.id\)/);
  });

  it('counts a paid purchase of the source post\'s recipe in any state, never a free unlock', () => {
    const bought = functionText(sql, 'CREATE OR REPLACE FUNCTION public.remix_source_bought_paid(');
    expect(bought).toMatch(/WHERE p\.generation_id = p_source_generation_id/);
    expect(bought).toMatch(/AND purchase\.price_usd_cents > 0/);
    expect(bought).toMatch(/AND purchase\.buyer_user_id IN \(SELECT public\.linked_account_ids\(p_user_id\)\)/);
    expect(bought).not.toMatch(/status/);
  });

  it('keeps the mode on the post, past the deletion of its creation, from nothing a caller writes', () => {
    const copy = functionText(sql, 'CREATE OR REPLACE FUNCTION public.copy_generation_remix_terms_to_post()');
    expect(sql).toMatch(
      /CREATE TRIGGER posts_copy_remix_terms\s+BEFORE INSERT OR UPDATE OF generation_id, remix_recipe_mode ON public\.posts/,
    );
    expect(normalize(copy)).toContain(normalize(`
      IF NEW.generation_id IS NOT NULL THEN
        NEW.remix_recipe_mode := (
          SELECT g.remix_recipe_mode FROM public.generations AS g WHERE g.id = NEW.generation_id
        );
      ELSIF TG_OP = 'INSERT' THEN
        NEW.remix_recipe_mode := NULL;
      ELSE
        NEW.remix_recipe_mode := OLD.remix_recipe_mode;
      END IF;
    `));
  });

  it('keeps every function off the client roles', () => {
    for (const signature of [
      'remix_source_bought_paid(uuid, uuid)',
      'remix_terms_for(uuid, uuid)',
      'record_generation_remix_terms()',
      'copy_generation_remix_terms_to_post()',
      'record_completed_post_remix()',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
    }
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.remix_source_bought_paid(uuid, uuid) TO service_role;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.remix_terms_for(uuid, uuid) TO service_role;');
  });

  it('changes nothing in the remix credit but the self-remix rule', () => {
    const previous = functionText(
      readMigration('20261030022210_remix_credit_follows_linked_guest_creations.sql'),
      'CREATE OR REPLACE FUNCTION public.record_completed_post_remix()',
    );
    expect(credit).toMatch(SELF_REMIX_EXCLUSION);
    expect(normalize(credit.replace(SELF_REMIX_EXCLUSION, ';'))).toBe(normalize(previous));
  });
});

describe('the remix terms backfill', () => {
  const sql = readMigration('20261105132114_remix_terms_backfill.sql');
  const backfill = functionText(sql, 'CREATE OR REPLACE FUNCTION public.backfill_remix_recipe_terms()');

  it('runs in a transaction of its own that gives up on a lock, and calls its function once', () => {
    expectLockTimeoutTransaction(sql);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.backfill_remix_recipe_terms() FROM PUBLIC, anon, authenticated;');
    expect(sql.match(/SELECT public\.backfill_remix_recipe_terms\(\);/g)).toHaveLength(1);
  });

  it('fills remix runs oldest first, so each inherits from a filled source, then their posts', () => {
    expect(backfill).toMatch(/WHERE g\.source_generation_id IS NOT NULL\s+ORDER BY g\.created_at, g\.id/);
    expect(backfill.indexOf('ORDER BY g.created_at, g.id'))
      .toBeLessThan(backfill.indexOf('SET remix_recipe_mode = g.remix_recipe_mode'));
  });

  it('clears a paid version\'s prompt on its post and drops the remixes a post\'s owner made', () => {
    expect(normalize(backfill)).toContain(normalize(`
      UPDATE public.posts AS p
      SET prompt = NULL
      WHERE p.remix_recipe_mode = 'paid'
        AND p.prompt IS NOT NULL
    `));
    expect(normalize(backfill)).toContain(normalize(`
      DELETE FROM public.completed_post_remixes AS remix
      USING public.posts AS p
      WHERE p.id = remix.post_id
        AND remix.actor_user_id IN (SELECT public.linked_account_ids(p.user_id))
    `));
  });

  // The content freeze refuses a write to a post whose owner is being deleted, which would fail
  // the migration and the release (20261031055009 left those posts alone for the same reason).
  it('leaves alone every post whose owner has an account deletion job', () => {
    const postWrites = backfill.split(/;\n/).filter((statement) => /public\.(posts|completed_post_remixes)\b/.test(statement)
      && /\b(UPDATE|DELETE)\b/.test(statement));
    expect(postWrites).toHaveLength(3);
    for (const statement of postWrites) {
      expect(statement).toMatch(/AND NOT public\.is_account_deletion_requested\(p\.user_id\)/);
    }
  });
});
