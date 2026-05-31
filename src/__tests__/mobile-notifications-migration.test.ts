import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260519120000_mobile_notifications.sql'
);

describe('mobile notifications migration', () => {
  it('creates the notification tables with row-level security', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.mobile_notifications');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.mobile_push_tokens');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.mobile_notification_preferences');
    expect(migration).toContain('ALTER TABLE public.mobile_notifications ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE public.mobile_push_tokens ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE public.mobile_notification_preferences ENABLE ROW LEVEL SECURITY');
  });

  it('limits exposed tables to authenticated users and owner-scoped policies', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.mobile_notifications TO authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.mobile_push_tokens TO authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON public.mobile_notification_preferences TO authenticated');
    expect(migration).toContain('auth.uid() = user_id');
    expect(migration).not.toContain('TO anon');
  });
});
