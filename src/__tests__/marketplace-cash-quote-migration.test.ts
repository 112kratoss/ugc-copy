import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(process.cwd(),
  'supabase/migrations/20260928044248_pin_marketplace_cash_quotes.sql'), 'utf8');

describe('marketplace cash quote migration', () => {
  it('keeps settlement service-only and historical quotes unguessed', () => {
    const signature = 'public.complete_marketplace_purchase(text, text)';
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).not.toMatch(/UPDATE public.marketplace_orders\s+SET quoted_price_usd_cents/i);
    expect(migration).not.toMatch(/DROP\s+(TABLE|FUNCTION)|TRUNCATE/i);
  });
});
