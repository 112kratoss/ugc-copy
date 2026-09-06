import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20260905213637_private_generation_playback_renditions.sql',
  'utf8',
);
describe('private generation playback schema', () => {
  it('keeps claim and preflight service-only with crash-safe attempts and bounded storage admission', () => {
    expect(sql).toContain('FOR UPDATE OF g SKIP LOCKED');
    expect(sql).toContain(
      'playback_rendition_attempt_count = g.playback_rendition_attempt_count + 1',
    );
    expect(sql).toContain('67108864');
    for (const signature of [
      'claim_generation_playback_rendition(text,bigint)',
      'has_pending_generation_playback_rendition()',
    ]) {
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated`,
      );
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
    }
  });
});
