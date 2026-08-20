import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819073000_identity_and_linked_deletion_hardening.sql',
), 'utf8');

const contractMigration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/contract_migrations/security_remediation_stage3.sql',
), 'utf8');

describe('identity and linked deletion hardening migration', () => {
  it('persists and backfills the complete profile lifecycle', () => {
    expect(migration).toContain("identity_state text NOT NULL DEFAULT 'active'");
    expect(migration).toContain("identity_state IN ('active', 'merged', 'deleting')");
    expect(migration).toContain("WHEN merged_into_user_id IS NOT NULL THEN 'merged'");
    expect(migration).toContain("SET identity_state = 'deleting'");
    expect(migration).toContain('profiles_enforce_identity_state_transition');
  });

  it('never reactivates historical guests whose merge target was already deleted', () => {
    expect(migration).toContain("WHEN merged_at IS NOT NULL THEN 'deleting'");
    expect(migration).toContain('profiles_identity_state_shape_check');
    expect(migration).toContain('PERFORM public.prepare_account_deletion(orphan.id)');
  });

  it('gates relation- and column-level authenticated grants with restrictive RLS', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.current_identity_is_active()');
    expect(migration).toContain('aclexplode(relation.relacl)');
    expect(migration).toContain('aclexplode(attribute.attacl)');
    expect(migration).toContain('CREATE POLICY authenticated_identity_active');
    expect(migration).toContain('AS RESTRICTIVE FOR ALL TO authenticated');
  });

  it('snapshots all linked identities and makes compatibility target-first deletion fail closed', () => {
    expect(migration).toContain("'owner_user_ids', to_jsonb(v_owner_ids)");
    expect(migration).toContain('generation.user_id = ANY(v_owner_ids)');
    expect(migration).toContain('post.user_id = ANY(v_owner_ids)');
    expect(migration).toContain('template.creator_user_id = ANY(v_owner_ids)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.enqueue_detached_merged_identity_deletion()');
    expect(migration).toContain('PERFORM public.prepare_account_deletion(NEW.id)');
    expect(migration).not.toContain('ON DELETE RESTRICT');
  });

  it('defers the restrictive merge foreign key until the stage-3 telemetry gate', () => {
    expect(contractMigration).toContain('DEFERRED STAGE-3 CONTRACT MIGRATION');
    expect(contractMigration).toContain('profiles_merged_into_user_id_fkey');
    expect(contractMigration).toContain('ON DELETE RESTRICT');
  });
});
