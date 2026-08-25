import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const read = (file: string) => fs.readFileSync(path.join(migrationsDirectory, file), 'utf8');

const migration = read('20260825140000_drop_unguarded_refund_credits.sql');
const generationServices = fs.readFileSync(
  path.resolve(process.cwd(), 'src/lib/generation-services.ts'),
  'utf8',
);

describe('drop unguarded refund_credits migration', () => {
  it('drops the function', () => {
    // It credited an arbitrary user an arbitrary amount: no idempotency key, no
    // source row, no bound. Its siblings went in 20260725232000; this one
    // survived only because a caller still referenced it.
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.refund_credits(uuid, integer);');
  });

  it('leaves the guarded refund paths alone', () => {
    // Each of these settles against its own source row and is idempotent through
    // a `refunded` flag or a status transition. Dropping one would strand held
    // credits on failure.
    for (const survivor of [
      'settle_generation_failed',
      'settle_generation_start_failed',
      'settle_template_generation_start_failed',
      'settle_ai_usage_event',
      'refund_creation_credit_reservation',
    ]) {
      expect(migration).not.toContain(`DROP FUNCTION IF EXISTS public.${survivor}`);
    }
  });

  it('removes the only caller in the same change', () => {
    // A drop that landed while the call site remained would turn every template
    // start-failure into a 42883 at runtime.
    expect(generationServices).not.toContain("rpc('refund_credits'");
    expect(generationServices).not.toContain('refundCreditsQuietly');
  });

  it('stops branching on a missing settlement RPC', () => {
    // The fallback existed for a database older than the code, which
    // production-release.yml prevents: it migrates, stages, verifies, then
    // promotes. Keeping the branch would keep a reason to reintroduce the
    // primitive.
    // Matched against the branch itself rather than the bare error codes — the
    // comment explaining what was removed deliberately still names them.
    expect(generationServices).not.toContain("errorCode === 'PGRST202'");
    expect(generationServices).not.toContain('missingRpc');
    expect(generationServices).not.toContain('legacy_fallback');
  });

  it('still settles template start failures through the atomic RPC', () => {
    expect(generationServices).toContain("rpc('settle_template_generation_start_failed'");
  });
});
