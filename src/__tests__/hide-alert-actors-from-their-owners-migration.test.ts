import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261019091221_hide_alert_actors_from_their_owners.sql',
), 'utf8');

function grantedColumns() {
  const match = /GRANT SELECT \(([^)]*)\) ON TABLE public\.mobile_notifications TO authenticated;/.exec(migration);
  if (!match) throw new Error('Expected a column SELECT grant to authenticated');
  return match[1].split(',').map((column) => column.trim()).filter(Boolean);
}

describe('hide alert actors from their owners migration', () => {
  it('takes back the table-wide read and gives the owner only the columns Alerts show', () => {
    expect(migration).toContain('REVOKE SELECT ON TABLE public.mobile_notifications FROM authenticated;');
    expect(grantedColumns()).toEqual([
      'id', 'user_id', 'type', 'category', 'title', 'body', 'deep_link', 'object_type', 'object_id',
      'event_count', 'is_read', 'created_at', 'updated_at', 'last_event_at',
    ]);
  });

  it('never lets an owner read who is behind an alert', () => {
    // `dedupe_key` carries the saver's id in a named save's key.
    expect(grantedColumns()).not.toContain('actor_user_id');
    expect(grantedColumns()).not.toContain('dedupe_key');
  });

  it('covers every column the inbox selects', () => {
    const inbox = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/mobile-notification-inbox-service.ts'), 'utf8');
    for (const column of ['id', 'type', 'category', 'title', 'body', 'deep_link', 'object_type', 'object_id', 'event_count', 'is_read', 'created_at', 'last_event_at']) {
      expect(inbox).toContain(column);
      expect(grantedColumns()).toContain(column);
    }
  });
});
