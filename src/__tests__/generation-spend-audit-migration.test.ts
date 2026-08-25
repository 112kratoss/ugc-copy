import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations', file),
  'utf8',
);

const migration = read('20260825130000_generation_spend_audit.sql');

describe('generation spend audit migration', () => {
  it('captures the credit facts a hard delete would destroy', () => {
    // `generations` doubles as the spend record and generation-delete-service
    // issues a hard DELETE, so tidying up a creation erased the only evidence
    // that credits were spent. On production that is 4,775 untraceable credits.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.generation_spend_audits');
    for (const column of ['cost', 'promotional_credits_used', 'refunded', 'generation_created_at']) {
      expect(migration).toContain(column);
    }
  });

  it('records the refund flag so net spend stays reconstructable', () => {
    // A refunded generation cost the user nothing. Without this the audit would
    // overstate spend for every failed run.
    expect(migration).toContain('coalesce(OLD.refunded, false)');
  });

  it('skips the audit when the account itself is being deleted', () => {
    // generations.user_id is REFERENCES auth.users ON DELETE CASCADE, so this
    // trigger fires during account deletion too. The auth row is already gone by
    // then, so the insert would fail its own foreign key and abort the deletion.
    // Skipping is also the right semantics: an erased account must not leave its
    // spend history behind.
    expect(migration).toContain('IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN');
    expect(migration.indexOf('IF NOT EXISTS (SELECT 1 FROM auth.users'))
      .toBeLessThan(migration.indexOf('INSERT INTO public.generation_spend_audits'));
  });

  it('never lets the audit abort the delete that triggers it', () => {
    // A CHECK rejection inside an AFTER DELETE trigger would roll back a
    // deletion the user asked for. The promotional figure is clamped instead.
    expect(migration).toContain('least(greatest(coalesce(OLD.promotional_credits_used, 0), 0), OLD.cost)');
    expect(migration).toContain('ON CONFLICT (generation_id) DO NOTHING');
  });

  it('keeps one row per generation so reconciliation cannot double-count', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS generation_spend_audits_generation_idx');
  });

  it('skips free generations', () => {
    expect(migration).toContain('IF coalesce(OLD.cost, 0) <= 0 THEN');
  });

  it('touches no existing money function', () => {
    // The nineteen functions that write profiles.credits are the money path.
    // This fixes an audit gap and must not put a balance mutation at risk.
    expect(migration).not.toContain('public.profiles');
    expect(migration).not.toMatch(/credits\s*=\s*credits/);
    expect(migration).not.toContain('start_generation');
    expect(migration).not.toContain('settle_generation');
  });

  it('is append-only and operator-only', () => {
    expect(migration).toContain('ALTER TABLE public.generation_spend_audits ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.generation_spend_audits FROM authenticated;');
    // SELECT and INSERT only — no UPDATE or DELETE grant, so the ledger cannot
    // be rewritten by the code that writes it.
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.generation_spend_audits TO service_role;');
    expect(migration).not.toMatch(/GRANT[^;]*UPDATE[^;]*generation_spend_audits/);
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*generation_spend_audits/);
  });

  it('revokes service_role before granting it, so append-only actually holds', () => {
    // Supabase's default privileges hand every new table in `public` the full
    // arwdDxtm set to anon, authenticated *and* service_role. Without the
    // revoke, `GRANT SELECT, INSERT` adds nothing the role did not already have
    // and UPDATE/DELETE survive — the exact grant drift that lets a local pass
    // mask a broken guarantee.
    expect(migration).toContain('REVOKE ALL ON TABLE public.generation_spend_audits FROM service_role;');
    expect(migration.indexOf('REVOKE ALL ON TABLE public.generation_spend_audits FROM service_role;'))
      .toBeLessThan(migration.indexOf('GRANT SELECT, INSERT ON TABLE public.generation_spend_audits TO service_role;'));
  });

  it('fires after the delete, on every row', () => {
    expect(migration).toContain('AFTER DELETE ON public.generations');
    expect(migration).toContain('FOR EACH ROW');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path TO 'public', 'pg_temp'");
  });
});
