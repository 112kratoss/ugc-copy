import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260819074000_admin_sessions_v2.sql'),
  'utf8',
);

describe('admin session migration', () => {
  it('keeps session rows service-role-only', () => {
    expect(migration).toMatch(/ALTER TABLE public\.admin_sessions ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.admin_sessions FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.admin_sessions TO service_role/i,
    );
    expect(migration).not.toMatch(/CREATE\s+(?:PERMISSIVE\s+|RESTRICTIVE\s+)?POLICY/i);
  });

  it('stores revocation, expiry, and keyed credential-version state', () => {
    expect(migration).toContain('session_id uuid PRIMARY KEY');
    expect(migration).toContain('credential_version text NOT NULL');
    expect(migration).toContain('expires_at timestamptz NOT NULL');
    expect(migration).toContain('revoked_at timestamptz');
  });
});
