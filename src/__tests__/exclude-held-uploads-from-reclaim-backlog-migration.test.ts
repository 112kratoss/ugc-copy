import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260906160000_exclude_held_uploads_from_reclaim_backlog.sql',
), 'utf8');

const sweep = fs.readFileSync(path.resolve(
  process.cwd(),
  'src/lib/upload-finalization.ts',
), 'utf8');

describe('exclude held uploads from reclaim backlog migration', () => {
  it('replaces the health function in place rather than dropping it', () => {
    // The output columns are unchanged, so a DROP would open a window where the
    // running build's call fails for no reason.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_upload_reclaim_health');
    expect(migration).not.toContain('DROP FUNCTION IF EXISTS public.get_upload_reclaim_health');
    expect(migration).toContain('p_include_abandoned boolean DEFAULT true');
  });

  it('keeps a live draft out of the backlog and counts it as withheld instead', () => {
    // Both sets must consult the same predicate, or a held row either pages as
    // a backlog or vanishes from the report entirely.
    expect(migration).toContain('AND NOT public.upload_reservation_intent_held(');
    expect(migration).toContain('OR public.upload_reservation_intent_held(');
    expect(migration.match(/public\.upload_reservation_intent_held\(/g)).toHaveLength(5);
  });

  it('mirrors the hold the sweep actually applies', () => {
    // loadProtectedMobileUploadKeys is the authority; these are the four
    // clauses it tests, and they have to stay in step or health starts lying.
    expect(migration).toContain("p_bucket_id = 'uploads'");
    expect(migration).toContain('intent.storage_cleared_at IS NULL');
    expect(migration).toContain("p_finalization_status <> 'deleted'");
    expect(migration).toContain("p_consumption_disposition IS DISTINCT FROM 'delete'");
    // mayReclaimExplicitAbandon, expressed as RECLAIM_AFTER_HOURS.
    expect(migration).toContain("p_client_finalized_at <= p_now - interval '48 hours'");
    expect(sweep).toContain('storage_cleared_at');
  });

  it('still reports the rollout hold, and only through the withheld set', () => {
    expect(migration).toContain('AND (p_include_abandoned OR reservation.consumed_at IS NOT NULL)');
    expect(migration).toContain('(NOT p_include_abandoned AND reservation.consumed_at IS NULL)');
  });

  it('ages an actionable row from when it became eligible, not from when it expired', () => {
    expect(migration).toContain('coalesce(reservation.reclaim_after, reservation.expires_at)');
    expect(migration).toContain('SELECT min(actionable.actionable_at) FROM actionable');
  });

  it('keeps the bounded sample and the service-role-only grants', () => {
    expect(migration.match(/LIMIT 20001/g)).toHaveLength(3);
    expect(migration.match(/SET search_path = ''/g)).toHaveLength(2);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.upload_reservation_intent_held(');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.upload_reservation_intent_held(');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_upload_reclaim_health(timestamptz, boolean)');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_upload_reclaim_health(timestamptz, boolean)');
    expect(migration.match(/TO service_role;/g)).toHaveLength(2);
  });
});
