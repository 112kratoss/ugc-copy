import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const migrationsRoot = path.resolve(repoRoot, 'supabase/migrations');
const migration = fs.readFileSync(path.join(migrationsRoot, '20261019122652_save_alerts_follow_the_save.sql'), 'utf8');

/** The file's statements, comments left out, in order. */
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  // Function bodies hold semicolons of their own: keep each one whole.
  .split(/;\s*\n(?![^$]*\$\$;)/)
  .map((statement) => statement.trim())
  .filter(Boolean);

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('\n$$;', start));
}

/** Where a statement starting with `prefix` sits among the file's statements. */
function statementIndex(prefix: string | RegExp) {
  const index = statements.findIndex((statement) => (
    typeof prefix === 'string' ? statement.startsWith(prefix) : prefix.test(statement)
  ));
  expect(index, String(prefix)).toBeGreaterThanOrEqual(0);
  return index;
}

// The live definitions and the behaviour (cascades, blocks, naming, the
// lock's place in each function) are pinned in
// supabase/tests/database/post_save_alerts.test.sql and
// src/__tests__/post-save-alert-database.test.ts.
describe('save alerts follow the save migration', () => {
  it('ties a named save alert to its save, so the save going takes the alert with it', () => {
    expect(migration).toMatch(/FOREIGN KEY \(save_user_id, save_post_id\)\s+REFERENCES public\.post_saves \(user_id, post_id\)\s+ON DELETE CASCADE;/);
    expect(migration).toContain('CHECK ((save_user_id IS NULL) = (save_post_id IS NULL))');
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS mobile_notifications_save_idx\s+ON public\.mobile_notifications \(save_user_id, save_post_id\)/);
    expect(functionBody('create_post_save_alert')).toMatch(/EXCEPTION WHEN foreign_key_violation THEN[\s\S]*'wasCreated', false/);
    // Nothing keeps the two in step by hand any more.
    expect(migration).not.toMatch(/withdrawn_at|withdraw_post_save_alert|hashtextextended\(\s*'post-save:/);
  });

  // Review 4 finding #10: one place for every lock, in the order live writers
  // take them, before anything changes.
  it('takes every table lock it needs at the top, saves first and deliveries before alerts', () => {
    // In a block: a file applied outside a transaction block refuses a bare LOCK TABLE.
    const block = /DO \$locks\$\s+BEGIN\s+([\s\S]*?)\s+END;\s+\$locks\$;/.exec(migration);
    expect(block).not.toBeNull();
    expect(block![1].split(/;\s*/).filter(Boolean)).toEqual([
      // SET LOCAL does nothing where the file is applied outside a transaction block.
      "PERFORM set_config('lock_timeout', '5s', true)",
      'LOCK TABLE public.post_saves IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE public.mobile_push_deliveries IN ACCESS EXCLUSIVE MODE',
      'LOCK TABLE public.mobile_notifications IN ACCESS EXCLUSIVE MODE',
    ]);
    const firstChange = statements.findIndex((statement) => /^(ALTER|CREATE|DROP|UPDATE)\b/.test(statement));
    expect(statementIndex('DO $locks$')).toBeLessThan(firstChange);
    expect(statementIndex('DO $locks$')).toBe(1);
    // No lock is asked for later, behind work already holding others.
    expect(statements.join('\n').match(/LOCK TABLE/g)).toHaveLength(3);
  });

  // Review 4 finding #18: the timeout comes first, in a statement, not a comment.
  it('gives its locks a timeout before it takes any, and leaves profiles to its own migration', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(migration).not.toMatch(/ALTER TABLE public\.profiles/);
  });

  it("builds the alerts' save index before the key, so the key's check reads it", () => {
    expect(statementIndex('CREATE INDEX IF NOT EXISTS mobile_notifications_save_idx'))
      .toBeLessThan(statementIndex(/ADD CONSTRAINT mobile_notifications_save_fkey/));
  });

  it('keeps a delivery, for its receipt, when its alert goes, its key checked later outside these locks', () => {
    expect(migration).toContain('ALTER COLUMN notification_id DROP NOT NULL');
    expect(migration).toMatch(/FOREIGN KEY \(notification_id\) REFERENCES public\.mobile_notifications \(id\)\s+ON DELETE SET NULL NOT VALID;/);
    const validate = fs.readFileSync(path.join(migrationsRoot, '20261019211235_validate_push_delivery_alert_key.sql'), 'utf8');
    expect(validate).toMatch(/ALTER TABLE public\.mobile_push_deliveries\s+VALIDATE CONSTRAINT mobile_push_deliveries_notification_id_fkey;/);
    expect(validate).toContain("SET LOCAL lock_timeout = '5s';");
    expect(validate).not.toMatch(/LOCK TABLE|ACCESS EXCLUSIVE/);
  });

  // Review 4 finding #8: a retry is claimed only while its alert stands.
  it('claims no retry of a delivery whose alert is gone', () => {
    const claim = functionBody('claim_mobile_push_retry');
    expect(claim).toMatch(/WHERE id = p_delivery_id AND notification_id IS NOT NULL/);
    // Otherwise as it was: one attempt per claim, fenced by the expected count.
    expect(claim).toContain('attempt_count = attempt_count + 1');
    expect(claim).toContain('attempt_count = p_expected_attempt_count');
    expect(claim).toContain("LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''");
  });

  // Review 4 finding #11: who may be named, and to whom, is the function's.
  it('writes a named alert only to the post owner, for a saver told on record by a handle they chose, its title its own', () => {
    const create = functionBody('create_post_save_alert');
    expect(create).toMatch(/create_post_save_alert\(\s+p_post_id uuid,\s+p_saver_user_id uuid,\s+p_body text,\s+p_deep_link text\s+\)/);
    expect(create).toMatch(/SELECT post\.user_id INTO v_recipient_user_id\s+FROM public\.posts AS post\s+WHERE post\.id = p_post_id;/);
    expect(create).toMatch(/SELECT profile\.username, profile\.saver_notice_seen_at\s+INTO v_username, v_seen_at\s+FROM public\.profiles AS profile\s+WHERE profile\.id = p_saver_user_id;/);
    expect(create).toMatch(/IF v_seen_at IS NULL\s+OR v_handle !~ '\^\[a-z0-9-\]\{3,24\}\$'\s+OR v_handle ~ '\^creator-\[a-f0-9\]\{8\}\$' THEN\s+RETURN jsonb_build_object\('nameable', false/);
    expect(create).toContain("'@' || v_handle || ' saved your post'");
    expect(create).not.toMatch(/p_title|p_recipient_user_id/);

    // The same rule as the app's: a handle the person chose (src/lib/profile.ts).
    const profile = fs.readFileSync(path.join(repoRoot, 'src/lib/profile.ts'), 'utf8');
    expect(profile).toContain('const USERNAME_PATTERN = /^[a-z0-9-]{3,24}$/;');
    expect(profile).toContain('const GENERATED_USERNAME_PATTERN = /^creator-[a-f0-9]{8}$/;');
    expect(profile).toMatch(/value\.trim\(\)\.replace\(\/\^@\+\/, ''\)\.toLowerCase\(\)/);
    expect(create).toContain("lower(regexp_replace(btrim(coalesce(v_username, '')), '^@+', ''))");
  });

  it('answers in the shape the grouped writer does, saying whether the saver could be named', () => {
    const create = functionBody('create_post_save_alert');
    expect(create).toMatch(/'nameable', true,\s+'wasCreated', v_created,\s+'notification', CASE WHEN v_created THEN to_jsonb\(v_row\) END/);
    expect(functionBody('upsert_mobile_notification')).toMatch(/'notification', to_jsonb\(v_row\),\s+'wasCreated', v_was_created/);
  });

  // Review 4 finding #28: one per-pair lock and one block trigger.
  it("takes the follow-block lock a block takes, and removes a pair's alerts in the block trigger that removes their follows", () => {
    const pairLock = (left: string, right: string) => new RegExp(
      `hashtextextended\\(\\s*'follow-block:' \\|\\| least\\(${left}, ${right}\\)::text\\s*\\|\\| ':' \\|\\|\\s*greatest\\(${left}, ${right}\\)::text,\\s*0\\s*\\)\\)`,
    );
    const create = functionBody('create_post_save_alert');
    expect(create).toMatch(pairLock('v_recipient_user_id', 'p_saver_user_id'));
    expect(create.search(pairLock('v_recipient_user_id', 'p_saver_user_id'))).toBeLessThan(create.indexOf('public.user_blocks'));
    expect(create.indexOf('public.user_blocks')).toBeLessThan(create.indexOf('INSERT INTO public.mobile_notifications'));
    expect(create).toMatch(/FROM public\.user_blocks\s+WHERE \(blocker_user_id = v_recipient_user_id AND blocked_user_id = p_saver_user_id\)\s+OR \(blocker_user_id = p_saver_user_id AND blocked_user_id = v_recipient_user_id\)/);

    const block = functionBody('remove_follows_for_user_block');
    expect(block).toMatch(pairLock('NEW\\.blocker_user_id', 'NEW\\.blocked_user_id'));
    expect(block.search(pairLock('NEW\\.blocker_user_id', 'NEW\\.blocked_user_id'))).toBeLessThan(block.indexOf('DELETE FROM public.follows'));
    expect(block.indexOf('DELETE FROM public.follows')).toBeLessThan(block.indexOf('DELETE FROM public.mobile_notifications'));
    expect(block).toContain('(user_id = NEW.blocker_user_id AND save_user_id = NEW.blocked_user_id)');
    expect(block).toContain('(user_id = NEW.blocked_user_id AND save_user_id = NEW.blocker_user_id)');
    // No second lock key, function or trigger of its own.
    expect(migration).not.toMatch(/'user-pair:'|remove_post_save_alerts_for_user_block|CREATE TRIGGER/);
  });

  it('stores no actor on grouped save and share rows, whoever calls, and leaves the rows written to their own migration', () => {
    const upsert = functionBody('upsert_mobile_notification');
    expect(upsert).toMatch(/v_actor_user_id uuid := CASE\s+WHEN p_type IN \('post_saved', 'post_shared'\) THEN NULL\s+ELSE p_actor_user_id\s+END;/);
    expect(upsert).not.toMatch(/VALUES \(\s+p_user_id,\s+p_actor_user_id/);
    expect(migration).not.toMatch(/DISABLE TRIGGER|UPDATE public\.mobile_notifications\s+SET/);

    const repair = fs.readFileSync(path.join(migrationsRoot, '20261019211233_clear_actor_from_grouped_alerts.sql'), 'utf8');
    expect(repair).toMatch(/DISABLE TRIGGER mobile_notifications_set_updated_at;\s+UPDATE public\.mobile_notifications\s+SET actor_user_id = NULL\s+WHERE type IN \('post_saved', 'post_shared'\)\s+AND aggregation_key IS NOT NULL/);
    expect(repair).toContain('ENABLE TRIGGER mobile_notifications_set_updated_at;');
    expect(repair).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('lets only the service call the functions it defines', () => {
    for (const signature of [
      'create_post_save_alert(uuid, uuid, text, text)',
      'remove_follows_for_user_block()',
    ]) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&')}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&')}\\s+TO service_role;`));
    }
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.upsert_mobile_notification\([^)]*\) FROM PUBLIC, anon, authenticated;/);
  });
});
