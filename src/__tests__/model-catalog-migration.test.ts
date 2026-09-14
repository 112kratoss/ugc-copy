import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps catalog read RPCs bounded, published-only and service-role-only', () => {
  const sql = readFileSync(
    'supabase/migrations/20260914054905_model_catalog_v1_reads.sql',
    'utf8',
  );
  expect(sql).toContain(
    "status IN ('active', 'retired') AND activated_at IS NOT NULL",
  );
  expect(sql).toContain('LIMIT p_limit');
  expect(sql).toContain('cardinality(p_ids) > 8');
  expect(sql.match(/FROM PUBLIC, anon, authenticated/g)).toHaveLength(3);
  expect(sql).not.toMatch(/provider_model_map|pricing_config|adapter_config/);
});
