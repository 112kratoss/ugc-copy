import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(process.cwd(),
  'supabase/migrations/20260927035014_enforce_registered_notification_ownership.sql'), 'utf8');

describe('registered notification ownership migration', () => {
  it.each(['mobile_notifications', 'mobile_notification_preferences', 'mobile_push_tokens'])(
    'adds restrictive registration and active-session gates to %s', (table) => {
      expect(migration).toContain(`CREATE POLICY registered_identity_only\nON public.${table} AS RESTRICTIVE FOR ALL TO authenticated`);
      expect(migration).toContain(`CREATE POLICY authenticated_identity_active\nON public.${table} AS RESTRICTIVE FOR ALL TO authenticated`);
    },
  );
  it('checks both existing and new rows without rewriting customer data or grants', () => {
    expect(migration.match(/WITH CHECK \(\(SELECT public.current_identity_is_registered\(\)\)\)/g)).toHaveLength(3);
    expect(migration.match(/WITH CHECK \(\(SELECT public.current_identity_is_active\(\)\)\)/g)).toHaveLength(3);
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).not.toMatch(/\b(?:DELETE FROM|UPDATE public|INSERT INTO|GRANT|REVOKE)\b/);
  });
});
