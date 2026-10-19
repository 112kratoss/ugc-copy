import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsRoot = path.resolve(process.cwd(), 'supabase/migrations');
const migration = fs.readFileSync(path.join(migrationsRoot, '20261019122652_save_alerts_follow_the_save.sql'), 'utf8');

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('\n$$;', start));
}

// The live definitions and the behaviour (cascades, blocks, the lock's place
// in each function) are pinned in supabase/tests/database/post_save_alerts.test.sql.
describe('save alerts follow the save migration', () => {
  it('ties a named save alert to its save, so the save going takes the alert with it', () => {
    expect(migration).toMatch(/FOREIGN KEY \(save_user_id, save_post_id\)\s+REFERENCES public\.post_saves \(user_id, post_id\)\s+ON DELETE CASCADE;/);
    expect(migration).toContain('CHECK ((save_user_id IS NULL) = (save_post_id IS NULL))');
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS mobile_notifications_save_idx\s+ON public\.mobile_notifications \(save_user_id, save_post_id\)/);
    expect(functionBody('create_post_save_alert')).toMatch(/EXCEPTION WHEN foreign_key_violation THEN[\s\S]*'wasCreated', false/);
    // Nothing keeps the two in step by hand any more.
    expect(migration).not.toMatch(/withdrawn_at|withdraw_post_save_alert|hashtextextended\(\s*'post-save:/);
  });

  it('keeps a delivery, for its receipt, when its alert goes', () => {
    expect(migration).toContain('ALTER COLUMN notification_id DROP NOT NULL');
    expect(migration).toMatch(/FOREIGN KEY \(notification_id\) REFERENCES public\.mobile_notifications \(id\)\s+ON DELETE SET NULL;/);
  });

  it('writes no named alert across a block, and a block removes the ones written', () => {
    const create = functionBody('create_post_save_alert');
    expect(create).toMatch(/FROM public\.user_blocks\s+WHERE \(blocker_user_id = p_recipient_user_id AND blocked_user_id = p_actor_user_id\)\s+OR \(blocker_user_id = p_actor_user_id AND blocked_user_id = p_recipient_user_id\)/);
    expect(migration).toMatch(/CREATE TRIGGER user_blocks_remove_post_save_alerts\s+AFTER INSERT OR UPDATE ON public\.user_blocks/);
    const trigger = functionBody('remove_post_save_alerts_for_user_block');
    expect(trigger).toContain('(user_id = NEW.blocker_user_id AND save_user_id = NEW.blocked_user_id)');
    expect(trigger).toContain('(user_id = NEW.blocked_user_id AND save_user_id = NEW.blocker_user_id)');
  });

  it('takes one lock per pair of accounts in both, before what it guards', () => {
    const pairLock = (left: string, right: string) => new RegExp(
      `pg_advisory_xact_lock\\(hashtextextended\\(\\s*'user-pair:' \\|\\| least\\(${left}, ${right}\\)::text\\s*\\|\\| ':' \\|\\| greatest\\(${left}, ${right}\\)::text,\\s*0\\s*\\)\\)`,
    );
    const create = functionBody('create_post_save_alert');
    expect(create).toMatch(pairLock('p_recipient_user_id', 'p_actor_user_id'));
    expect(create.search(pairLock('p_recipient_user_id', 'p_actor_user_id'))).toBeLessThan(create.indexOf('public.user_blocks'));
    expect(create.indexOf('public.user_blocks')).toBeLessThan(create.indexOf('INSERT INTO public.mobile_notifications'));

    const trigger = functionBody('remove_post_save_alerts_for_user_block');
    expect(trigger).toMatch(pairLock('NEW.blocker_user_id', 'NEW.blocked_user_id'));
    expect(trigger.search(pairLock('NEW.blocker_user_id', 'NEW.blocked_user_id'))).toBeLessThan(trigger.indexOf('DELETE FROM'));
  });

  it('answers in the shape the grouped writer does', () => {
    const create = functionBody('create_post_save_alert');
    expect(create).toMatch(/'wasCreated', v_created,\s+'notification', CASE WHEN v_created THEN to_jsonb\(v_row\) END/);
    expect(functionBody('upsert_mobile_notification')).toMatch(/'notification', to_jsonb\(v_row\),\s+'wasCreated', v_was_created/);
  });

  it('stores no actor on grouped save and share rows, whoever calls, and clears the ones written', () => {
    const upsert = functionBody('upsert_mobile_notification');
    expect(upsert).toMatch(/v_actor_user_id uuid := CASE\s+WHEN p_type IN \('post_saved', 'post_shared'\) THEN NULL\s+ELSE p_actor_user_id\s+END;/);
    expect(upsert).not.toMatch(/VALUES \(\s+p_user_id,\s+p_actor_user_id/);
    expect(migration).toMatch(/DISABLE TRIGGER mobile_notifications_set_updated_at;\s+UPDATE public\.mobile_notifications\s+SET actor_user_id = NULL\s+WHERE type IN \('post_saved', 'post_shared'\)\s+AND aggregation_key IS NOT NULL/);
    expect(migration).toContain('ENABLE TRIGGER mobile_notifications_set_updated_at;');
  });

  it('lets only the service call the functions it defines', () => {
    for (const signature of [
      'create_post_save_alert(uuid, uuid, uuid, text, text, text)',
      'remove_post_save_alerts_for_user_block()',
    ]) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&')}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&')}\\s+TO service_role;`));
    }
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.upsert_mobile_notification\([^)]*\) FROM PUBLIC, anon, authenticated;/);
  });

  it('gives its locks a timeout, and leaves profiles to its own migration', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';");
    // saver-notice-seen-at-migration.test.ts
    expect(migration).not.toMatch(/ALTER TABLE public\.profiles/);
  });
});
