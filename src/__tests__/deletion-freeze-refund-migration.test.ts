import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const migration = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20261006173448_allow_refund_sale_count_during_deletion.sql'), 'utf8');
describe('refund during deletion content freeze migration', () => {
  it('permits only the refund count write while preserving content and function access boundaries', () => {
    expect(migration).toContain("IF TG_OP = 'UPDATE'");
    expect(migration).toContain('OLD.sales_count > 0 AND NEW.sales_count = OLD.sales_count - 1');
    expect(migration).toContain("to_jsonb(NEW) - ARRAY['sales_count', 'updated_at']");
    expect(migration).toContain("to_jsonb(OLD) - ARRAY['sales_count', 'updated_at']");
    expect(migration).toContain('pg_trigger_depth() > 1');
    expect(migration).toContain('public.is_account_deletion_requested(NEW.owner_user_id)');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).not.toMatch(/GRANT\s+EXECUTE|DROP\s+(TABLE|FUNCTION)|TRUNCATE/i);
  });
});
