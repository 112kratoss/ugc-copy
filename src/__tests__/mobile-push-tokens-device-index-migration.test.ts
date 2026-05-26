import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260526074835_mobile_push_tokens_device_index.sql'
);

describe('mobile push tokens device index migration', () => {
  it('adds a filtered index for active device cleanup lookups', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE INDEX IF NOT EXISTS mobile_push_tokens_user_device_active_idx');
    expect(migration).toContain('ON public.mobile_push_tokens (user_id, device_id, is_active)');
    expect(migration).toContain('WHERE device_id IS NOT NULL');
  });
});
