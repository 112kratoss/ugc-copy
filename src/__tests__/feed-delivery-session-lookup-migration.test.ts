import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('feed continuation delivery-fact lookup', () => {
  it('indexes the session template lookup without duplicating the telemetry payload', () => {
    const sql = fs.readFileSync(path.resolve(
      'supabase/migrations/20260921054302_feed_delivery_session_lookup.sql',
    ), 'utf8');
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS feed_delivery_facts_session_idx\s+ON public\.feed_delivery_facts \(session_id\);/);
    expect(sql).not.toMatch(/\bINCLUDE\s*\(/i);
    expect(sql).toContain("SET LOCAL lock_timeout = '2s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
  });
});
