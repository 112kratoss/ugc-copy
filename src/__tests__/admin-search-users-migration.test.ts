import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20261114050722_admin_search_users_by_account_kind.sql'),
  'utf8',
);

describe('admin user search migration', () => {
  it('tells guests from accounts by auth.users.is_anonymous, which no client can write', () => {
    // 540 of production's 620 profiles were guests listed as "Unnamed" people.
    expect(migration).toContain('JOIN auth.users AS account ON account.id = profile.id');
    expect(migration).toContain("p_kind = 'registered' AND NOT coalesce(account.is_anonymous, false)");
    expect(migration).toContain("p_kind = 'guests' AND coalesce(account.is_anonymous, false)");
    expect(migration).not.toMatch(/creator-\[a-f0-9\]/);
  });

  it('refuses a kind it does not know rather than listing everyone', () => {
    expect(migration).toContain("p_kind NOT IN ('registered', 'guests', 'all')");
    expect(migration).toContain("ERRCODE = '22023'");
  });

  it('treats LIKE wildcards in the search term as letters', () => {
    expect(migration).toContain("replace(replace(replace(v_term, '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
  });

  it('pages and counts in the database, with bounded limits', () => {
    expect(migration).toContain('count(*) OVER () AS total_count');
    expect(migration).toContain('least(greatest(coalesce(p_limit, 25), 1), 100)');
    expect(migration).toContain('ORDER BY profile.created_at DESC, profile.id DESC');
  });

  it('is an operator-only definer function with a fixed search path', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.admin_search_users(text, text, integer, integer) FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.admin_search_users(text, text, integer, integer) TO service_role;');
  });
});
