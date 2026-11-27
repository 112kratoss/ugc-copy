import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Database audit, 2026-11-27: Supabase's advisor listed four foreign keys without a covering
 * index (agent_oauth_authorizations.client_id, .grant_id, .user_id and
 * completed_post_remixes.actor_user_id). A delete of the referenced row then scans the whole
 * referencing table under its lock. supabase/tests/database/foreign_key_covering_indexes.test.sql
 * proves the indexes on a replayed database; this pins the migration's shape.
 */
const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs.readdirSync(migrationsDir).find((file) => file.endsWith('_foreign_key_covering_indexes.sql'));
const migration = migrationFile ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8') : '';
const body = migration.replace(/^\s*--.*$/gm, '');

describe('foreign keys get covering indexes', () => {
  it('exists and bounds its lock wait', () => {
    expect(migrationFile).toBeTruthy();
    expect(body).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it.each([
    ['agent_oauth_authorizations_client_id_idx', 'public.agent_oauth_authorizations (client_id)'],
    ['agent_oauth_authorizations_grant_id_idx', 'public.agent_oauth_authorizations (grant_id)'],
    ['agent_oauth_authorizations_user_id_idx', 'public.agent_oauth_authorizations (user_id)'],
    ['completed_post_remixes_actor_user_id_idx', 'public.completed_post_remixes (actor_user_id)'],
  ])('creates %s', (name, target) => {
    expect(body).toContain(`CREATE INDEX IF NOT EXISTS ${name} ON ${target};`);
  });
});
