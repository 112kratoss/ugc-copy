import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MOBILE_NOTIFICATION_INBOX_FILTER_COLUMNS,
  MOBILE_NOTIFICATION_INBOX_SELECT,
} from '@/lib/mobile-notification-inbox-service';

const readMigration = (name: string) => fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', name), 'utf8');
const migration = readMigration('20261019091221_hide_alert_actors_from_their_owners.sql');
const followingMigration = readMigration('20261019122652_save_alerts_follow_the_save.sql');

function grantedColumns(source: string) {
  return [...source.matchAll(/GRANT SELECT \(([^)]*)\) ON TABLE public\.mobile_notifications TO authenticated;/g)]
    .flatMap((match) => match[1].split(','))
    .map((column) => column.trim())
    .filter(Boolean);
}

/** What `authenticated` may read once both migrations have run. */
const granted = [...grantedColumns(migration), ...grantedColumns(followingMigration)];

describe('hide alert actors from their owners migration', () => {
  it('takes back the table-wide read and gives the owner only the columns Alerts show', () => {
    expect(migration).toContain('REVOKE SELECT ON TABLE public.mobile_notifications FROM authenticated;');
    expect(grantedColumns(migration)).toEqual([
      'id', 'user_id', 'type', 'category', 'title', 'body', 'deep_link', 'object_type', 'object_id',
      'event_count', 'is_read', 'created_at', 'updated_at', 'last_event_at',
    ]);
  });

  it('never lets an owner read who is behind an alert', () => {
    // `dedupe_key` carries the saver's id in a named save's key.
    expect(granted).not.toContain('actor_user_id');
    expect(granted).not.toContain('dedupe_key');
    expect(granted).not.toContain('aggregation_key');
  });

  it('grants every column the inbox selects, filters and orders on, read from the inbox itself', () => {
    // Alerts are read with the owner's own token: a column outside the grant
    // fails every Alerts request, with every test that mocks the client green.
    const inboxColumns = [
      ...MOBILE_NOTIFICATION_INBOX_SELECT.split(',').map((column) => column.trim()),
      ...MOBILE_NOTIFICATION_INBOX_FILTER_COLUMNS,
    ];
    expect(inboxColumns.filter((column) => !granted.includes(column))).toEqual([]);

    const inbox = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/mobile-notification-inbox-service.ts'), 'utf8');
    const filtered = [...inbox.matchAll(/\.(?:eq|is|in|lt|lte|order)\('([a-z_]+)'/g)].map((match) => match[1]);
    expect(filtered.length).toBeGreaterThan(0);
    expect([...new Set(filtered)].filter((column) => !granted.includes(column))).toEqual([]);
  });

  it('says how Alerts are read', () => {
    expect(migration).toContain("with the owner's own token");
    expect(migration).not.toContain('reads with the service role');
  });
});
