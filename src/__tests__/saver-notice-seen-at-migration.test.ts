import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20261019182554_saver_notice_seen_at.sql'),
  'utf8',
);

// That an account cannot write the column itself is pinned live in
// supabase/tests/database/post_save_alerts.test.sql.
describe('saver notice seen at migration', () => {
  it('adds the record of being told, as a nullable time', () => {
    expect(migration).toContain('ALTER TABLE public.profiles\n  ADD COLUMN IF NOT EXISTS saver_notice_seen_at timestamptz;');
    expect(migration).not.toMatch(/saver_notice_seen_at timestamptz\s+(NOT NULL|DEFAULT)/);
    expect(migration).toContain('COMMENT ON COLUMN public.profiles.saver_notice_seen_at IS');
  });

  it('gives up its lock on profiles after five seconds, and changes nothing else', () => {
    // Every admitted API call reads profiles (current_identity_admission).
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';");
    expect(migration.indexOf("SET LOCAL lock_timeout = '5s';")).toBeLessThan(migration.indexOf('ALTER TABLE public.profiles'));
    const statements = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements.map((statement) => statement.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SET LOCAL',
      'ALTER TABLE',
      'COMMENT ON',
    ]);
  });

  it('grants owners no way to write it: only the service role records a telling', () => {
    expect(migration).not.toMatch(/\bGRANT\b/);
  });
});
