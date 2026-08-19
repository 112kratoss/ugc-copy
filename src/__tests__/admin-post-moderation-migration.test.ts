import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819030000_admin_post_moderation_actions.sql',
), 'utf8');

describe('admin post moderation migration', () => {
  it('records the operator and a mandatory justification for every visibility change', () => {
    expect(migration).toContain('CREATE TABLE public.admin_post_moderation_actions');
    expect(migration).toContain('reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT');
    expect(migration).toContain('CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000)');
    expect(migration).toContain("IF char_length(v_reason) < 3 OR char_length(v_reason) > 1000 THEN");
  });

  it('offers a reversible removal alongside the irreversible one', () => {
    // The whole point of the split: `take_down` destroys the creator's media,
    // so an operator making a provisional call needs an action that does not.
    expect(migration).toContain("CHECK (action IN ('hide', 'take_down', 'restore'))");
    expect(migration).toContain("v_media_revoked := (p_action = 'take_down');");
  });

  it('only closes open reports on a take-down, never on a provisional hide', () => {
    // A hide is not a verdict. Beyond being the honest reading, this is what
    // keeps `post_reports.resolution_action = 'take_down'` meaning exactly one
    // thing product-wide -- that the post's media was revoked -- which is the
    // signal `restore` refuses on. When `hide` also wrote that value, hiding a
    // reported post silently made it permanently unrestorable.
    expect(migration).toContain("IF p_action = 'take_down' THEN\n      UPDATE public.post_reports");
    expect(migration).toMatch(/resolution_action = 'take_down',\n\s+resolution_note = v_reason/);
  });

  it('refuses to restore a post whose media was destroyed, by either removal path', () => {
    expect(migration).toContain("'status', 'not_restorable'");
    // Both sources of a revocation are checked: this table's own take-downs and
    // report resolutions, which run the same Storage delete.
    expect(migration).toContain('FROM public.admin_post_moderation_actions\n      WHERE post_id = p_post_id\n        AND media_revocation_required');
    expect(migration).toContain("FROM public.post_reports\n      WHERE post_id = p_post_id\n        AND resolution_action = 'take_down'");
  });

  it('restores only the paid surfaces a removal actually pulled down', () => {
    // Recorded ids rather than a blanket republish, so a bundle the creator had
    // drafted themselves is not resurrected by an unrelated restore.
    expect(migration).toContain('drafted_bundle_ids uuid[] NOT NULL');
    expect(migration).toContain('unlisted_asset_ids uuid[] NOT NULL');
    expect(migration).toContain('WHERE id = ANY (v_last_removal.drafted_bundle_ids)');
    expect(migration).toContain('WHERE id = ANY (v_last_removal.unlisted_asset_ids)');
  });

  it('returns a restored post to flagged, not visible, while a report is still open', () => {
    expect(migration).toContain("v_status_after := CASE WHEN v_open_reports > 0 THEN 'flagged' ELSE 'visible' END;");
  });

  it('makes a replayed action idempotent instead of applying it twice', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX admin_post_moderation_actions_idempotency_key_idx');
    expect(migration).toContain("'status', 'already_applied'");
    expect(migration).toContain('WHERE idempotency_key = v_key');
  });

  it('locks the post row so a proactive action and a report resolution cannot interleave', () => {
    // Same lock target and order as resolve_post_report_for_ops.
    expect(migration).toContain('FROM public.posts\n  WHERE id = p_post_id\n  FOR UPDATE');
  });

  it('keeps operator audit data off the public Data API', () => {
    expect(migration).toContain('ALTER TABLE public.admin_post_moderation_actions ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.admin_post_moderation_actions FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE public.admin_post_moderation_actions TO service_role');
  });

  it('restricts the moderation RPC to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.apply_admin_post_moderation(uuid, uuid, text, text, text)\n  FROM PUBLIC, anon, authenticated',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.apply_admin_post_moderation(uuid, uuid, text, text, text)\n  TO service_role',
    );
    expect(migration).toContain('SET search_path = public, pg_temp');
  });
});
