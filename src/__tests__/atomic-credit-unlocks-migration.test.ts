import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_atomic_credit_unlocks.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('atomic credit unlock migration', () => {
  it('moves both credit-funded unlocks into database transactions', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.unlock_marketplace_asset_with_credits');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.unlock_post_resource_bundle_with_credits');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('UPDATE public.profiles');
    expect(migration).toContain('INSERT INTO public.marketplace_purchases');
    expect(migration).toContain('INSERT INTO public.post_resource_bundle_purchases');
  });

  it('keeps the transaction RPCs private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) FROM PUBLIC');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) TO service_role');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) TO service_role');
  });
});
