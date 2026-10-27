import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', file), 'utf8');
const migration = read('20261020053858_unname_sale_alerts_across_blocks_and_deletion.sql');

/** The migration's statements, without its comments. */
const code = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

// What the triggers do to stored alerts is pinned live in
// supabase/tests/database/sale_alert_names.test.sql.
describe('unname sale alerts across blocks and deletion migration', () => {
  it('takes the name out of the words the server wrote then, back to the words it wrote with no name', () => {
    // The words of 2026-10-20, which rows written until 20261027180743 keep;
    // that migration's test holds the live words (`sellerUnlockWords`) to the
    // function as it is now, which matches both.
    const freeOpenNames = new RegExp(/p_title ~ '([^']+)'/.exec(code)![1]);
    const saleNames = new RegExp(/p_body ~ '([^']+)'/.exec(code)![1]);

    for (const handle of ['maya', 'creator-0a1b2c3d']) {
      expect(`@${handle} opened your free resources`).toMatch(freeOpenNames);
      expect(`@${handle} bought the resources attached to your post.`).toMatch(saleNames);
    }
    expect('Someone opened your free resources').not.toMatch(freeOpenNames);
    expect('A creator bought the resources attached to your post.').not.toMatch(saleNames);

    expect(code).toContain("title := 'Someone opened your free resources';");
    expect(code).toContain("body := 'A creator opened the resources attached to your post.';");
    expect(code).toContain("body := 'A creator bought the resources attached to your post.';");
  });

  it('stores an alert unnamed when it is written across a block, or once its buyer is deleted', () => {
    expect(code).toContain([
      'CREATE OR REPLACE TRIGGER mobile_notifications_unname_sale_alert_across_block',
      'BEFORE INSERT ON public.mobile_notifications',
      'FOR EACH ROW',
      "WHEN (NEW.type = 'post_resource_unlocked' AND NEW.actor_user_id IS NOT NULL)",
      'EXECUTE FUNCTION public.unname_sale_alert_that_cannot_name();',
    ].join('\n'));
    // The foreign key's ON DELETE SET NULL is an update of actor_user_id.
    expect(read('20260519120000_mobile_notifications.sql'))
      .toContain('actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL');
    expect(code).toContain([
      'CREATE OR REPLACE TRIGGER mobile_notifications_unname_sale_alert_of_deleted_buyer',
      'BEFORE UPDATE OF actor_user_id ON public.mobile_notifications',
      'FOR EACH ROW',
      'WHEN (',
      "  NEW.type = 'post_resource_unlocked'",
      '  AND OLD.actor_user_id IS NOT NULL',
      '  AND NEW.actor_user_id IS NULL',
      ')',
    ].join('\n'));
  });

  it('takes the name out when a block comes later, either way round, in the one trigger on blocks', () => {
    // The function is as 20261019122652 defined it, with the sale alerts added:
    // every statement it had is still there, in the same order.
    const statements = (sql: string) => {
      const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()');
      const end = sql.indexOf('$$;', sql.indexOf('AS $$', start));
      return sql.slice(start, end).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('--'));
    };
    const before = statements(read('20261019122652_save_alerts_follow_the_save.sql'));
    const after = statements(migration);
    let next = 0;
    for (const line of before) {
      next = after.indexOf(line, next) + 1;
      expect(next, line).toBeGreaterThan(0);
    }
    expect(code).toContain('(named.user_id = NEW.blocker_user_id AND named.actor_user_id = NEW.blocked_user_id)');
    expect(code).toContain('OR (named.user_id = NEW.blocked_user_id AND named.actor_user_id = NEW.blocker_user_id)');
    // Taken after the lock, as the alerts it removes are.
    const blockFunction = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()'));
    expect(blockFunction.indexOf('pg_advisory_xact_lock')).toBeLessThan(blockFunction.indexOf('UPDATE public.mobile_notifications'));
    // No second trigger on blocks: post_save_alerts.test.sql counts one.
    expect(code).not.toMatch(/TRIGGER \w+\s+(AFTER|BEFORE)[^;]*ON public\.user_blocks/);
  });

  it('takes the per-pair lock a block and a named save alert take, so neither misses the other', () => {
    const saveAlerts = read('20261019122652_save_alerts_follow_the_save.sql');
    const blockLock = "'follow-block:' || least(NEW.blocker_user_id, NEW.blocked_user_id)::text || ':' ||\n"
      + '    greatest(NEW.blocker_user_id, NEW.blocked_user_id)::text, 0';
    expect(saveAlerts).toContain(blockLock);
    expect(code).toContain(blockLock);
    expect(code).toContain("'follow-block:' || least(NEW.user_id, NEW.actor_user_id)::text || ':' ||\n"
      + '      greatest(NEW.user_id, NEW.actor_user_id)::text, 0');
  });

  it('locks mobile_notifications before it changes anything, gives up after five seconds, and never drops a trigger', () => {
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(code).toContain("PERFORM set_config('lock_timeout', '5s', true);");
    const alerts = code.indexOf('LOCK TABLE public.mobile_notifications IN SHARE ROW EXCLUSIVE MODE;');
    expect(alerts).toBeGreaterThan(-1);
    expect(alerts).toBeLessThan(code.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(code.match(/LOCK TABLE/g)).toHaveLength(1);
    // DROP TRIGGER would lock the inbox's reads out of mobile_notifications.
    expect(code).not.toMatch(/DROP TRIGGER/);
  });

  it('keeps every function out of the Data API, on a fixed search path', () => {
    for (const fn of [
      'unnamed_sale_alert_words(text, text)',
      'unname_sale_alert_that_cannot_name()',
      'remove_follows_for_user_block()',
    ]) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
    }
    expect(code.match(/SET search_path = ''/g)).toHaveLength(3);
  });
});
