import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260820010000_admin_moderation_audit_integrity.sql',
), 'utf8');

describe('admin moderation audit integrity migration', () => {
  it('checks generation transitions only after locking the current row', () => {
    const lock = migration.indexOf('FROM public.generations\n  WHERE id = p_generation_id\n  FOR UPDATE');
    const duplicateRemoveGuard = migration.indexOf(
      "IF p_action = 'remove' AND v_generation.moderation_removed_at IS NOT NULL THEN",
    );
    const invalidRestoreGuard = migration.indexOf(
      "IF p_action = 'restore' AND v_generation.moderation_removed_at IS NULL THEN",
    );

    expect(lock).toBeGreaterThan(-1);
    expect(duplicateRemoveGuard).toBeGreaterThan(lock);
    expect(invalidRestoreGuard).toBeGreaterThan(lock);
  });

  it('restores the first removal in the active cycle, not a duplicate snapshot', () => {
    expect(migration).toContain('FROM public.admin_generation_moderation_actions AS removal');
    expect(migration).toContain("restoration.action = 'restore'");
    expect(migration).toContain(
      '(restoration.created_at, restoration.id) > (removal.created_at, removal.id)',
    );
    expect(migration).toContain('ORDER BY removal.created_at ASC, removal.id ASC');
    expect(migration).toContain('archived_at = v_active_removal.previous_archived_at');
  });

  it('refuses to clear a moderation marker without an active removal audit row', () => {
    const missingAuditGuard = migration.indexOf('active moderation removal has no audit record');
    const restoreUpdate = migration.indexOf('SET moderation_removed_at = NULL');

    expect(missingAuditGuard).toBeGreaterThan(-1);
    expect(restoreUpdate).toBeGreaterThan(missingAuditGuard);
  });

  it('leaves existing contact attribution untouched on a repeated handle', () => {
    const replayGuard = migration.indexOf(
      'IF p_handled AND v_message.handled_at IS NOT NULL THEN',
    );
    const handledUpdate = migration.indexOf('SET handled_at = v_now');

    expect(replayGuard).toBeGreaterThan(-1);
    expect(handledUpdate).toBeGreaterThan(replayGuard);
    expect(migration.slice(replayGuard, handledUpdate)).not.toContain('handled_by = p_reviewer_id');
  });

  it('keeps both corrected functions restricted to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.apply_admin_generation_moderation(uuid, uuid, text, text, text)',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.set_contact_message_handled(uuid, uuid, boolean, text)',
    );
  });
});
