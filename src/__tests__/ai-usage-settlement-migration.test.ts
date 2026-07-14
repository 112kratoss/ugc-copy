import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260714110000_atomic_ai_usage_settlement.sql',
), 'utf8');

describe('atomic AI usage settlement migration', () => {
  it('locks the usage event and applies the refund effect in one state-machine function', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.settle_ai_usage_event');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("p_outcome NOT IN ('succeeded', 'refunded')");
    expect(migration).toContain("v_event.status NOT IN ('pending', 'failed')");
    expect(migration).toContain('SET credits = credits + v_event.cost');
    expect(migration).toContain("SET status = 'refunded'");
    expect(migration).toContain("'already_refunded'");
    expect(migration).toContain("'already_succeeded'");
  });

  it('keeps settlement backend-only and routes the legacy refund through it', () => {
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('v_result := public.settle_ai_usage_event');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) FROM authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) TO service_role',
    );
  });
});
