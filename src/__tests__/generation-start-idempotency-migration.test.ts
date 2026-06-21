import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');

function readMigration(suffix: string) {
  const migrationName = fs.readdirSync(migrationsDirectory)
    .find((name) => name.endsWith(suffix));

  expect(migrationName).toBeDefined();
  return fs.readFileSync(path.join(migrationsDirectory, migrationName!), 'utf8');
}

describe('generation start idempotency migration', () => {
  it('stores only hashed client request keys and prevents duplicate starts per user', () => {
    const sql = readMigration('_generation_start_idempotency.sql');

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS client_request_key_hash text/i);
    expect(sql).toMatch(/generations_client_request_key_hash_sha256/i);
    expect(sql).toMatch(/client_request_key_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS generations_user_client_request_key_hash_idx/i);
    expect(sql).toMatch(/ON public\.generations \(user_id, client_request_key_hash\)/i);
    expect(sql).toMatch(/WHERE client_request_key_hash IS NOT NULL/i);
    expect(sql).toMatch(/Raw keys are never stored/i);
  });
});

describe('post resource bundle migration audit hardening', () => {
  it('keeps the historical migration audit table service-role only', () => {
    const sql = readMigration('_harden_post_resource_bundle_migration_audit.sql');

    expect(sql).toMatch(/ALTER TABLE public\.post_resource_bundle_migration_audit ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/REVOKE ALL ON public\.post_resource_bundle_migration_audit FROM PUBLIC/i);
    expect(sql).toMatch(/REVOKE ALL ON public\.post_resource_bundle_migration_audit FROM anon/i);
    expect(sql).toMatch(/REVOKE ALL ON public\.post_resource_bundle_migration_audit FROM authenticated/i);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.post_resource_bundle_migration_audit TO service_role/i);
    expect(sql).toMatch(/Access is restricted to service_role/i);
  });
});
