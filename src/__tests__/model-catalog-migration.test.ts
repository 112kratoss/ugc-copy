import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps catalog read RPCs bounded, published-only, platform-scoped and service-role-only', () => {
  const sql = readFileSync(
    'supabase/migrations/20260914054905_model_catalog_v1_reads.sql',
    'utf8',
  );
  expect(sql).toContain(
    "status IN ('active', 'retired') AND activated_at IS NOT NULL",
  );
  expect(sql).toContain('LIMIT p_limit');
  expect(sql).toContain('cardinality(p_ids) > 8');
  // Every read is scoped to one platform's availability; the transport never
  // collapses web and mobile into a single "enabled on both" projection.
  expect(sql.match(/p_platform NOT IN \('web', 'mobile'\)/g)).toHaveLength(3);
  expect(
    sql.match(
      /CASE p_platform WHEN 'mobile' THEN e\.mobile_enabled ELSE e\.web_enabled END/g,
    ),
  ).toHaveLength(3);
  expect(sql).not.toContain('web_enabled AND mobile_enabled');
  expect(sql).toContain("r.defaults -> p_platform");
  expect(sql.match(/FROM PUBLIC, anon, authenticated/g)).toHaveLength(3);
  expect(sql).not.toMatch(/provider_model_map|pricing_config|adapter_config/);
});
