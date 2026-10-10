import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = fs.readFileSync('supabase/migrations/20261010073728_atomic_workflow_assistant_message.sql', 'utf8');
describe('atomic workflow assistant message migration', () => {
  it('restricts the invoker transaction to service-role callers', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
    expect(migration).toContain("feature = 'workflow_assistant'");
    expect(migration).toContain('user_id = p_user_id');
  });
  it('serializes replacements and settles only after persisting both messages', () => {
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration.indexOf('public.settle_ai_usage_event')).toBeGreaterThan(migration.indexOf('INTO v_assistant_message'));
    expect(migration).toContain("v_event.status <> 'pending'");
    expect(migration).not.toMatch(/EXCEPTION\s+WHEN/i);
  });
});
