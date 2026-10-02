import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_mobile_notification_last_event_time.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

/** The statements, without the comments that explain them. */
const sql = migration.replace(/^\s*--.*$/gm, '');

describe('mobile notification last event time migration', () => {
  it('gives every alert a last event of its own', () => {
    expect(migrationName).toBeDefined();
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS last_event_at timestamptz/);
    expect(sql).toMatch(/ALTER COLUMN last_event_at SET DEFAULT timezone\('utc'::text, now\(\)\)/);
    expect(sql).toMatch(/ALTER COLUMN last_event_at SET NOT NULL/);
  });

  // A single alert's last event is its arrival. A grouped alert's events all
  // fall inside one 15-minute window, so a later updated_at is a read.
  it('repairs existing alerts from their arrival, not from the time they were read', () => {
    expect(sql).toMatch(/WHEN event_count > 1 THEN least\(updated_at, created_at \+ interval '15 minutes'\)/);
    expect(sql).toMatch(/ELSE created_at/);
  });

  // The inbox still reads updated_at until the server that reads last_event_at
  // is live. A repair that stamped it would show every alert as "Just now".
  it('repairs them without stamping updated_at', () => {
    const disable = sql.indexOf('DISABLE TRIGGER mobile_notifications_set_updated_at');
    const repair = sql.indexOf('SET last_event_at = CASE');
    const enable = sql.indexOf('ENABLE TRIGGER mobile_notifications_set_updated_at');

    expect(disable).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(disable);
    expect(enable).toBeGreaterThan(repair);
    // One statement, so the trigger cannot be left off if the repair fails.
    const block = sql.slice(sql.lastIndexOf('DO $$', disable), sql.indexOf('$$;', enable));
    expect(block).toContain('DISABLE TRIGGER');
    expect(block).toContain('ENABLE TRIGGER');
  });

  it('keeps updated_at stamped on every write, for read-alert retention', () => {
    expect(sql).toContain('last_event_at');
    expect(sql).not.toMatch(/DROP TRIGGER/);
    expect(sql).not.toContain('prune_mobile_notification_retention');
    expect(sql).not.toContain('mobile_notifications_read_retention_idx');
  });

  it('indexes the inbox order and drops the index of the old one', () => {
    expect(sql).toContain('DROP INDEX IF EXISTS public.mobile_notifications_user_updated_idx');
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS mobile_notifications_user_last_event_idx\s+ON public\.mobile_notifications \(user_id, last_event_at DESC, id DESC\)/);
  });

  it('moves a grouped alert when another event joins it, and keeps the function service-only', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.upsert_mobile_notification');
    const conflictBranch = sql.slice(sql.indexOf('DO UPDATE SET'), sql.indexOf('RETURNING * INTO v_row'));
    expect(conflictBranch).toContain('event_count = public.mobile_notifications.event_count + 1');
    expect(conflictBranch).toContain("last_event_at = timezone('utc'::text, now())");
    expect(sql).toMatch(/SECURITY INVOKER\s+SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.upsert_mobile_notification\([\s\S]*?\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.upsert_mobile_notification\([\s\S]*?\) TO service_role/);
  });

  it('leaves the owner able to change only the read state', () => {
    expect(sql).toContain('last_event_at');
    expect(sql).not.toMatch(/GRANT[^;]*\bTO authenticated/);
  });
});
