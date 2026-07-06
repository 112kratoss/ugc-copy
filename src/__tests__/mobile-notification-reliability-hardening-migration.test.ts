import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_mobile_notification_reliability_hardening.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('mobile notification reliability hardening migration', () => {
  it('keeps active Expo push tokens exclusive to one account', () => {
    expect(migration).toContain('mobile_push_tokens_active_expo_push_token_idx');
    expect(migration).toContain('ON public.mobile_push_tokens (expo_push_token)');
    expect(migration).toContain('WHERE is_active = true');
  });

  it('restricts backend-owned notification writes while allowing owner read-state updates', () => {
    expect(migration).toContain('REVOKE INSERT, DELETE ON TABLE public.mobile_notifications FROM authenticated');
    expect(migration).toContain('REVOKE UPDATE ON TABLE public.mobile_notifications FROM authenticated');
    expect(migration).toContain('GRANT UPDATE (is_read) ON TABLE public.mobile_notifications TO authenticated');
  });

  it('adds atomic aggregation and retention support', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.upsert_mobile_notification');
    expect(migration).toContain('event_count = public.mobile_notifications.event_count + 1');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.upsert_mobile_notification');
    expect(migration).toContain('mobile_push_deliveries_retryable_idx');
    expect(migration).toContain('mobile_notifications_read_retention_idx');
  });
});
