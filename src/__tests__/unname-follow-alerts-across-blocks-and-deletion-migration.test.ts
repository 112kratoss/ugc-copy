import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  createMobileNotificationHistory,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { notifyCreatorFollowed } from '@/lib/mobile-notifications';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', file), 'utf8');
const migration = read('20261020072851_unname_follow_alerts_across_blocks_and_deletion.sql');

/** The migration's statements, without its comments. */
const code = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** The row the server writes for a follow, by the real notifier. */
async function followAlert(followerUsername: string | null) {
  const history = createMobileNotificationHistory();
  const elsewhere = (name: string) => {
    throw new Error(`Unexpected call: ${name}`);
  };
  const client = withMobileNotificationHistory({
    from: elsewhere,
    rpc: async (name: string) => elsewhere(name),
  } as unknown as SupabaseClient, history);
  await notifyCreatorFollowed(client, { followerUserId: 'follower-1', followingUserId: 'creator-1', followerUsername });
  expect(history.sent).toHaveLength(1);
  return history.sent[0] as { title: string; body: string; deep_link: string };
}

// What the triggers do to stored alerts is pinned live in
// supabase/tests/database/follow_alert_names.test.sql.
describe('unname follow alerts across blocks and deletion migration', () => {
  it('takes the name and the page out of what the server writes, back to what it writes with no handle', async () => {
    const namedBody = new RegExp(/p_body ~ '([^']+)'/.exec(code)![1]);
    const namedLink = new RegExp(/p_deep_link ~ '([^']+)'/.exec(code)![1]);

    for (const handle of ['maya', 'creator-0a1b2c3d']) {
      const named = await followAlert(handle);
      expect(named.body).toMatch(namedBody);
      expect(named.deep_link).toMatch(namedLink);
    }

    const unnamed = await followAlert(null);
    expect(unnamed.body).not.toMatch(namedBody);
    expect(unnamed.deep_link).not.toMatch(namedLink);
    expect(code).toContain(`body := '${unnamed.body}';`);
    expect(code).toContain(`deep_link := '${unnamed.deep_link}';`);
    // The title names no one, so it is never rewritten.
    expect((await followAlert('maya')).title).toBe(unnamed.title);
  });

  it('stores an alert unnamed when it is written across a block, or once its follower is deleted', () => {
    expect(code).toContain([
      'CREATE OR REPLACE TRIGGER mobile_notifications_unname_follow_alert_across_block',
      'BEFORE INSERT ON public.mobile_notifications',
      'FOR EACH ROW',
      "WHEN (NEW.type = 'creator_followed' AND NEW.actor_user_id IS NOT NULL)",
      'EXECUTE FUNCTION public.unname_follow_alert_that_cannot_name();',
    ].join('\n'));
    // The foreign key's ON DELETE SET NULL is an update of actor_user_id.
    expect(read('20260519120000_mobile_notifications.sql'))
      .toContain('actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL');
    expect(code).toContain([
      'CREATE OR REPLACE TRIGGER mobile_notifications_unname_follow_alert_of_deleted_follower',
      'BEFORE UPDATE OF actor_user_id ON public.mobile_notifications',
      'FOR EACH ROW',
      'WHEN (',
      "  NEW.type = 'creator_followed'",
      '  AND OLD.actor_user_id IS NOT NULL',
      '  AND NEW.actor_user_id IS NULL',
      ')',
      'EXECUTE FUNCTION public.unname_follow_alert_that_cannot_name();',
    ].join('\n'));
  });

  it('takes the name out when a block comes later, either way round, in the one trigger on blocks', () => {
    // The function is as 20261020053858 defined it, with the follow alerts
    // added: every statement it had is still there, in the same order.
    const statements = (sql: string) => {
      const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()');
      const end = sql.indexOf('$$;', sql.indexOf('AS $$', start));
      return sql.slice(start, end).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('--'));
    };
    const before = statements(read('20261020053858_unname_sale_alerts_across_blocks_and_deletion.sql'));
    const after = statements(migration);
    let next = 0;
    for (const line of before) {
      next = after.indexOf(line, next) + 1;
      expect(next, line).toBeGreaterThan(0);
    }
    const blockFunction = code.slice(
      code.indexOf('CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()'),
      code.indexOf('REVOKE ALL ON FUNCTION public.remove_follows_for_user_block()'),
    );
    const followAlerts = blockFunction.slice(blockFunction.indexOf("AND named.type = 'creator_followed'"));
    expect(followAlerts).toContain('(named.user_id = NEW.blocker_user_id AND named.actor_user_id = NEW.blocked_user_id)');
    expect(followAlerts).toContain('OR (named.user_id = NEW.blocked_user_id AND named.actor_user_id = NEW.blocker_user_id)');
    // Taken after the lock, as the alerts it removes are.
    expect(blockFunction.indexOf('pg_advisory_xact_lock'))
      .toBeLessThan(blockFunction.indexOf('public.unnamed_follow_alert_words(named.body, named.deep_link)'));
    // Unnamed, never removed: the row is the follow's dedupe record.
    expect(blockFunction).not.toMatch(/DELETE FROM public\.mobile_notifications[^;]*creator_followed/);
    // No second trigger on blocks: post_save_alerts.test.sql counts one.
    expect(code).not.toMatch(/TRIGGER \w+\s+(AFTER|BEFORE)[^;]*ON public\.user_blocks/);
  });

  it('takes the per-pair lock a block and a follow take, so neither misses the other', () => {
    const follows = read('20261004121413_serialize_follow_block_relationships.sql');
    const followLock = "'follow-block:' || least(NEW.follower_id, NEW.following_id)::text || ':' ||\n"
      + '    greatest(NEW.follower_id, NEW.following_id)::text, 0';
    const blockLock = "'follow-block:' || least(NEW.blocker_user_id, NEW.blocked_user_id)::text || ':' ||\n"
      + '    greatest(NEW.blocker_user_id, NEW.blocked_user_id)::text, 0';
    expect(follows).toContain(followLock);
    expect(follows).toContain(blockLock);
    expect(code).toContain(blockLock);
    expect(code).toContain("'follow-block:' || least(NEW.user_id, NEW.actor_user_id)::text || ':' ||\n"
      + '      greatest(NEW.user_id, NEW.actor_user_id)::text, 0');
  });

  it('repairs the alerts already stored, once the triggers are there, without restarting their retention', () => {
    const repair = code.slice(code.indexOf('DO $repair$'));
    expect(code.indexOf('DO $repair$')).toBeGreaterThan(code.lastIndexOf('CREATE OR REPLACE TRIGGER'));
    expect(repair).toContain('named.actor_user_id IS NULL');
    expect(repair).toContain('(block.blocker_user_id = named.user_id AND block.blocked_user_id = named.actor_user_id)');
    expect(repair).toContain('OR (block.blocker_user_id = named.actor_user_id AND block.blocked_user_id = named.user_id)');
    // One statement, so a failed repair cannot leave the trigger off.
    const off = repair.indexOf('DISABLE TRIGGER mobile_notifications_set_updated_at;');
    const update = repair.indexOf('UPDATE public.mobile_notifications AS alert');
    const on = repair.indexOf('ENABLE TRIGGER mobile_notifications_set_updated_at;');
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(update);
    expect(update).toBeLessThan(on);
    expect(on).toBeLessThan(repair.indexOf('END;\n$repair$;'));
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
      'unnamed_follow_alert_words(text, text)',
      'unname_follow_alert_that_cannot_name()',
      'remove_follows_for_user_block()',
    ]) {
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
    }
    expect(code.match(/SET search_path = ''/g)).toHaveLength(3);
  });
});
