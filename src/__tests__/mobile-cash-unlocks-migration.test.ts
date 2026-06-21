import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_atomic_mobile_cash_unlocks.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('atomic mobile cash unlock migration', () => {
  it('moves mobile cash unlock order creation and completion into database transactions', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.complete_mobile_marketplace_purchase');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.complete_mobile_post_resource_purchase');
    expect(migration).toContain('ON CONFLICT (razorpay_order_id) DO NOTHING');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('INSERT INTO public.marketplace_orders');
    expect(migration).toContain('INSERT INTO public.post_resource_bundle_orders');
    expect(migration).toContain('INSERT INTO public.marketplace_purchases');
    expect(migration).toContain('INSERT INTO public.post_resource_bundle_purchases');
  });

  it('keeps mobile cash unlock RPCs private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.complete_mobile_marketplace_purchase(uuid, uuid, text, text) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.complete_mobile_post_resource_purchase(uuid, uuid, text, text) FROM PUBLIC');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.complete_mobile_marketplace_purchase(uuid, uuid, text, text) TO service_role');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.complete_mobile_post_resource_purchase(uuid, uuid, text, text) TO service_role');
  });
});
