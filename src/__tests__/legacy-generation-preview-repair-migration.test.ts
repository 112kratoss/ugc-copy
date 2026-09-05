import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260905192259_admit_legacy_stored_visual_previews.sql', 'utf8');

describe('legacy generation preview repair migration', () => {
  it('extends the claim and its partial index while retaining the existing function grants and leases', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.claim_generation_preview_repairs');
    expect(sql).toContain('CREATE INDEX generations_preview_repair_idx');
    expect(sql).toContain('generation_rows.category IS NULL');
    expect(sql).toContain(String.raw`generated\_images/%`);
    expect(sql).toContain(String.raw`generated\_videos/%`);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT least(greatest(p_limit, 1), 100)');
    expect(sql).not.toMatch(/DROP FUNCTION|GRANT\s+.*\s+TO\s+(?:PUBLIC|anon|authenticated)/i);
  });
});
