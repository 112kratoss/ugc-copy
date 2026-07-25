import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();

const migration = fs.readFileSync(path.resolve(
  projectRoot,
  'supabase/migrations/20260725232000_drop_legacy_credit_functions.sql',
), 'utf8');

function readServerSource(relativePath: string) {
  return fs.readFileSync(path.resolve(projectRoot, relativePath), 'utf8');
}

describe('drop legacy credit functions migration', () => {
  it('drops the race-prone spend path and the superseded refund helper', () => {
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.deduct_credits(uuid, integer)');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.refund_generation(text)');
  });

  it('keeps refund_credits, which generation-services still calls', () => {
    expect(migration).not.toMatch(/DROP FUNCTION IF EXISTS public\.refund_credits/i);
    expect(readServerSource('src/lib/generation-services.ts'))
      .toContain("creditSupabase.rpc('refund_credits'");
  });

  it('leaves no server caller of the dropped RPCs behind', () => {
    // A surviving caller would turn into a runtime "function does not exist"
    // only when that path executed, so pin it here instead.
    const serverModules = fs.readdirSync(path.resolve(projectRoot, 'src/lib'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readServerSource(path.join('src/lib', name)))
      .join('\n');

    expect(serverModules).not.toContain("rpc('deduct_credits'");
    expect(serverModules).not.toContain("rpc('refund_generation'");
  });

  it('is re-runnable and drops nothing else', () => {
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from/i);
    const dropCount = migration.match(/DROP FUNCTION/gi)?.length ?? 0;
    expect(dropCount).toBe(2);
  });
});
