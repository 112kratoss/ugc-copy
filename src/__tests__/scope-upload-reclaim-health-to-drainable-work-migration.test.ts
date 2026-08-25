import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260825120000_scope_upload_reclaim_health_to_drainable_work.sql',
), 'utf8');

describe('scope upload reclaim health to drainable work migration', () => {
  it('replaces the old signature rather than trying to widen it in place', () => {
    // CREATE OR REPLACE cannot add output columns, so the drop is load-bearing.
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.get_upload_reclaim_health(timestamptz)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_upload_reclaim_health');
    expect(migration).toContain('withheld_rows bigint');
    expect(migration).toContain('withheld_rows_capped boolean');
  });

  it('defaults the new gate so the previous build keeps working mid-deploy', () => {
    // Migrations apply before the deployment is promoted, so the release that
    // calls this with p_now alone has to keep resolving.
    expect(migration).toContain('p_include_abandoned boolean DEFAULT true');
  });

  it('ages an actionable row from when it became eligible, not from when it expired', () => {
    expect(migration).toContain('coalesce(reservation.reclaim_after, reservation.expires_at)');
    expect(migration).toContain('AS actionable_at');
    expect(migration).toContain('SELECT min(actionable.actionable_at) FROM actionable');
    expect(migration).not.toContain('SELECT min(actionable.expires_at) FROM actionable');
  });

  it('counts rows the sweep may not touch separately from the backlog', () => {
    expect(migration).toContain('AND (p_include_abandoned OR reservation.consumed_at IS NOT NULL)');
    expect(migration).toContain('WHERE NOT p_include_abandoned');
    expect(migration).toContain('(SELECT count(*) FROM withheld) AS withheld_count');
  });

  it('keeps the bounded sample and the service-role-only grant', () => {
    expect(migration.match(/LIMIT 20001/g)).toHaveLength(3);
    expect(migration).toContain('SET search_path = \'\'');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_upload_reclaim_health(timestamptz, boolean)');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_upload_reclaim_health(timestamptz, boolean)');
    expect(migration).toContain('TO service_role;');
  });
});
