import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'supabase/migrations/20260727030000_lock_down_legacy_marketplace_data_api.sql',
  ),
  'utf8',
);

describe('legacy marketplace Data API lockdown', () => {
  it('removes all client table and policy access while preserving service access', () => {
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.marketplace_assets',
    );
    expect(migration).toContain(
      "'REVOKE ALL PRIVILEGES (%s) ON TABLE public.marketplace_assets FROM PUBLIC, anon, authenticated, service_role'",
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Sellers can view their own assets"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_assets',
    );
  });

  it('removes inert post-write policies that could reopen after an accidental grant', () => {
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Users can insert their own posts" ON public.posts',
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts',
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Users can delete their own posts" ON public.posts',
    );
  });
});
