import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819050000_admin_generation_moderation.sql',
), 'utf8');

const lifecycle = fs.readFileSync(path.resolve(
  process.cwd(),
  'src/lib/generation-lifecycle-service.ts',
), 'utf8');

describe('admin generation moderation migration', () => {
  /**
   * The security property the whole feature rests on. Removal is enforced
   * through `archived_at`, which the owner restore route clears — so without
   * this guard the creator of a moderated generation could put it straight back.
   */
  it('stops the creator undoing a moderation removal', () => {
    expect(migration).toContain('moderation_removed_at timestamptz');
    expect(lifecycle).toContain(".is('moderation_removed_at', null)");
  });

  it('hides the generation through the column every public read path filters', () => {
    expect(migration).toContain('archived_at = coalesce(archived_at, v_now)');
    expect(migration).toContain('is_public = false');
  });

  it('never overwrites an archive timestamp the creator already set', () => {
    // coalesce, not an unconditional assignment: the creator's own archive time
    // has to survive so a restore can put it back.
    expect(migration).toContain('coalesce(archived_at, v_now)');
    expect(migration).toContain('coalesce(archived_by_user_id, p_reviewer_id)');
  });

  it('captures the creator state so a restore is exact rather than assumed', () => {
    expect(migration).toContain('previous_archived_at timestamptz');
    expect(migration).toContain('previous_is_public boolean');
    expect(migration).toContain('archived_at = v_last_removal.previous_archived_at');
    expect(migration).toContain('is_public = coalesce(v_last_removal.previous_is_public, false)');
  });

  it('requires a rationale and an idempotency key', () => {
    expect(migration).toContain('CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000)');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS admin_generation_moderation_idempotency_key_idx');
    expect(migration).toContain("'status', 'already_applied'");
  });

  it('locks the generation row against concurrent decisions', () => {
    expect(migration).toContain('FROM public.generations\n  WHERE id = p_generation_id\n  FOR UPDATE');
  });

  it('keeps the audit table off the public Data API', () => {
    expect(migration).toContain('ALTER TABLE public.admin_generation_moderation_actions ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.admin_generation_moderation_actions FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.admin_generation_moderation_actions TO service_role');
  });

  it('grants execution only to service_role', () => {
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.apply_admin_generation_moderation(uuid, uuid, text, text, text)\n  TO service_role');
  });
});
