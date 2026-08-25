import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations', file),
  'utf8',
);

// Renamed off 20260825120000: main landed
// `scope_upload_reclaim_health_to_drainable_work` on that exact version while
// this branch was open, and the migration ledger keys on the timestamp, so the
// two would have collided.
const migration = read('20260826100000_admin_registered_user_counts.sql');

describe('admin registered user counts migration', () => {
  it('splits the population on auth.users.is_anonymous', () => {
    // The bug this fixes: the Overview counted `profiles` wholesale. Since
    // anonymous sign-in shipped, most rows are guests — one per first launch and
    // another per reinstall — so production read 93 users and 33 new this week
    // against a true 28 and 2.
    expect(migration).toContain('JOIN auth.users u ON u.id = p.id');
    expect(migration).toContain('NOT coalesce(u.is_anonymous, false)');
  });

  it('returns guests rather than silently dropping them', () => {
    // Guests are real load and real storage. Filtering them away would swap one
    // misleading number for another.
    expect(migration).toContain("'registered_total'");
    expect(migration).toContain("'registered_since'");
    expect(migration).toContain("'guest_total'");
    expect(migration).toContain("'guest_since'");
  });

  it('treats a null window as "all time" for both populations', () => {
    // The Overview asks for a 7-day window, but a null p_since must not collapse
    // the totals to zero.
    expect(migration.match(/p_since IS NULL OR p\.created_at >= p_since/g)).toHaveLength(2);
  });

  it('reads anonymity from auth.users, not from anything a client can write', () => {
    // `profiles` is client-writable through the profile route; is_anonymous is
    // set by the auth server alone. This is the same reason
    // 20260811120000 stopped using the username placeholder as a proxy.
    expect(migration).not.toMatch(/creator-\[a-f0-9\]/);
  });

  it('keeps the function operator-only', () => {
    // It enumerates every account in the system, including the guest split. No
    // client role has any business calling it.
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.admin_user_population_counts(timestamptz) FROM PUBLIC;');
    expect(migration).toContain('FROM authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.admin_user_population_counts(timestamptz) TO service_role;');
  });

  it('is declared STABLE so the planner can cache it within a statement', () => {
    expect(migration).toContain('STABLE');
  });
});
