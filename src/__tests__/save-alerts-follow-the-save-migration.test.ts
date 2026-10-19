import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsRoot = path.resolve(process.cwd(), 'supabase/migrations');
const migration = fs.readFileSync(path.join(migrationsRoot, '20261019122652_save_alerts_follow_the_save.sql'), 'utf8');
const saveStateMigration = fs.readFileSync(path.join(migrationsRoot, '20261004114652_maintain_post_save_counters.sql'), 'utf8');

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return migration.slice(start, migration.indexOf('\n$$;', start));
}

describe('save alerts follow the save migration', () => {
  it('keeps the telling on record per account, written only by the service', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS saver_notice_seen_at timestamptz');
    // Owners edit only the listed profile columns; this is not one of them.
    expect(migration).not.toMatch(/GRANT UPDATE[^;]*saver_notice_seen_at/);
  });

  it('writes and takes back a named save alert under the very lock the save itself takes', () => {
    const lock = /pg_advisory_xact_lock\(hashtextextended\('post-save:' \|\| (p_\w+)::text \|\| ':' \|\| (p_\w+)::text, 0\)\)/;
    const saveLock = lock.exec(saveStateMigration);
    expect(saveLock?.slice(1)).toEqual(['p_user_id', 'p_post_id']);

    for (const name of ['create_post_save_alert', 'withdraw_post_save_alert']) {
      expect(lock.exec(functionBody(name))?.slice(1), name).toEqual(['p_actor_user_id', 'p_post_id']);
    }
  });

  it('writes a named alert only while the save stands, and takes it back only once it is gone', () => {
    expect(functionBody('create_post_save_alert')).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM public\.post_saves/);
    expect(functionBody('withdraw_post_save_alert')).toMatch(/IF EXISTS \(\s*SELECT 1 FROM public\.post_saves[\s\S]*RETURN 0;/);
  });

  it('hides a taken-back alert rather than deleting it, and brings it back at the next save', () => {
    expect(functionBody('withdraw_post_save_alert')).toContain('SET withdrawn_at = timezone');
    expect(functionBody('withdraw_post_save_alert')).not.toContain('DELETE');
    expect(functionBody('create_post_save_alert')).toMatch(/ON CONFLICT \(user_id, dedupe_key\) WHERE dedupe_key IS NOT NULL DO UPDATE\s+SET withdrawn_at = NULL/);
    expect(functionBody('create_post_save_alert')).toContain('WHERE public.mobile_notifications.withdrawn_at IS NOT NULL');
    expect(migration).toContain('GRANT SELECT (withdrawn_at) ON TABLE public.mobile_notifications TO authenticated;');
  });

  it('deletes withdrawn alerts only once their deliveries are past retention', () => {
    expect(functionBody('prune_mobile_notification_retention'))
      .toMatch(/WHERE withdrawn_at IS NOT NULL AND withdrawn_at < p_delivery_cutoff/);
  });

  it('takes back the save alerts naming either of two accounts to the other', () => {
    const body = functionBody('withdraw_post_save_alerts_between');
    expect(body).toContain("user_id = p_first_user_id AND dedupe_key LIKE 'post-save:' || p_second_user_id::text || ':%'");
    expect(body).toContain("user_id = p_second_user_id AND dedupe_key LIKE 'post-save:' || p_first_user_id::text || ':%'");
  });

  it('lets only the service call the new functions', () => {
    for (const signature of [
      'create_post_save_alert(uuid, uuid, uuid, text, text, text)',
      'withdraw_post_save_alert(uuid, uuid, uuid)',
      'withdraw_post_save_alerts_between(uuid, uuid)',
      'prune_mobile_notification_retention(timestamptz, timestamptz, integer)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature}\n  TO service_role;`);
    }
  });

  it('clears the actor from anonymous save and share alerts without stamping them as written', () => {
    expect(migration).toMatch(/DISABLE TRIGGER mobile_notifications_set_updated_at;\s+UPDATE public\.mobile_notifications\s+SET actor_user_id = NULL\s+WHERE type IN \('post_saved', 'post_shared'\)\s+AND aggregation_key IS NOT NULL/);
    expect(migration).toContain('ENABLE TRIGGER mobile_notifications_set_updated_at;');
  });
});
