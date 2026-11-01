import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));
/** The claim as a migration defines it, from its CREATE to the end of its body. */
const definition = (text: string) => {
  const start = text.indexOf('CREATE OR REPLACE FUNCTION public.claim_media_rendition_repairs(');
  return code(text.slice(start, text.indexOf('$function$;', start) + '$function$;'.length));
};
const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

const sql = read('20261101090347_rendition_claim_returns_queue_order.sql');
const now = definition(sql);
// The definition this one replaces.
const before = definition(read('20260920190000_private_uploaded_post_media.sql'));

/**
 * The order itself is asserted by pgTAP (rendition_claim_queue_order.test.sql)
 * and on a real stack (media-rendition-budget-postgrest.test.ts). This pins
 * that nothing else about the claim changed.
 */
describe('the rendition claim hands its rows back in queue order', () => {
  it('keeps the signature and the rows it picks', () => {
    expect(before.length).toBeGreaterThan(0);
    expect(now.startsWith(before.slice(0, before.indexOf('), candidates AS (')))).toBe(true);
    expect(now).toContain(between(before, 'FROM public.post_media AS pm JOIN candidate_pool', 'FOR UPDATE OF pm SKIP LOCKED'));
  });

  it('takes the same lease and attempt', () => {
    expect(now).toContain(between(before, 'UPDATE public.post_media AS pm', 'RETURNING'));
  });

  it('returns the claimed rows ordered by their place in the queue', () => {
    expect(now).toContain('candidates.row_number AS queue_position');
    expect(now).toMatch(/FROM claimed ORDER BY claimed\.queue_position; END; \$function\$;$/);
  });

  it('changes nothing else', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(GRANT|REVOKE|ALTER|DROP)\b/);
  });
});
