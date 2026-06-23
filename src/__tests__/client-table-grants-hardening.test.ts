import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

function findGrantHardeningMigration() {
  return fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('_harden_client_table_grants.sql'))
    .sort()
    .at(-1);
}

describe('client table grant hardening migration', () => {
  it('removes anonymous mutations and structural privileges from every public table', () => {
    const migrationFile = findGrantHardeningMigration();
    expect(migrationFile).toBeTruthy();

    const migration = fs.readFileSync(path.join(migrationsDir, migrationFile as string), 'utf8');

    expect(migration).toContain("n.nspname = 'public'");
    expect(migration).toContain("c.relkind IN ('r', 'p')");
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %I.%I FROM anon",
    );
    expect(migration).toContain(
      "REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE %I.%I FROM authenticated",
    );
    expect(migration).not.toContain('REVOKE SELECT');
    expect(migration).not.toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE %I.%I FROM authenticated');
  });
});
