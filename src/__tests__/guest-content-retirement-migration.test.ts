import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261104135818_retire_idle_guests_with_content.sql',
);
const FIRST_LIST_PATH = path.join(
  process.cwd(),
  'supabase/migrations/20261015174821_guest_self_deletion_and_idle_guest_retention.sql',
);

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * pgTAP (guest_content_retirement.test.sql) asserts who is listed and each
 * exclusion. This pins the boundary in the SQL itself: read only, the
 * database's clock, a 180-day window, and every money, link, public and
 * moderation exclusion of the first list carried over.
 */
describe('the idle guests with content migration', () => {
  const sql = code(readFileSync(MIGRATION_PATH, 'utf8'));
  const firstList = code(readFileSync(FIRST_LIST_PATH, 'utf8'));

  it('only reads, as its owner, with a fixed search path, for the service role alone', () => {
    expect(sql).toContain('RETURNS TABLE (user_id uuid, created_at timestamptz, last_active_at timestamptz) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = \'\'');
    expect(sql).not.toMatch(/\b(DELETE FROM|UPDATE public\.|INSERT INTO)\b/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.list_idle_guest_identities_with_content(timestamptz, integer, uuid) FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.list_idle_guest_identities_with_content(timestamptz, integer, uuid) TO service_role;');
  });

  it('waits 180 days by the database\'s clock and answers at most 100', () => {
    expect(sql).toContain("v_cutoff timestamptz := least(coalesce(p_now, now()), now()) - interval '180 days';");
    expect(sql).toContain('v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 100);');
  });

  it('carries over every exclusion of the first list but the content ones', () => {
    // The content tables are exactly what this list requires instead.
    const content = [
      'public.generations AS generation_row',
      'public.generation_input_media AS input_media',
      'public.generation_start_requests AS start_request',
      'public.generation_spend_audits AS spend_audit',
      'public.ai_usage_events AS usage_event',
      'public.template_runs AS template_run',
      'public.workflow_canvases AS canvas',
      'public.workflow_canvas_runs AS canvas_run',
      'public.media_upload_intents AS upload_intent',
      'public.upload_byte_reservations AS reservation',
    ];
    const exclusions = [...firstList.matchAll(/AND NOT EXISTS \( SELECT 1 FROM (public\.[a-z_]+ AS [a-z_]+) WHERE/g)]
      .map((match) => match[1]);
    expect(exclusions.length).toBeGreaterThan(30);
    for (const exclusion of exclusions) {
      if (content.includes(exclusion)) {
        expect(sql, exclusion).toContain(`EXISTS (SELECT 1 FROM ${exclusion} WHERE`);
      } else {
        expect(sql, exclusion).toContain(`AND NOT EXISTS ( SELECT 1 FROM ${exclusion} WHERE`);
      }
    }
    for (const kept of [
      "AND profile.identity_state = 'active'",
      'AND profile.merged_into_user_id IS NULL',
      'AND coalesce(profile.credits, 0) = 0',
      'AND coalesce(profile.promotional_credits, 0) = 0',
      'WHERE guest.is_anonymous AND (p_user_id IS NULL OR guest.id = p_user_id)',
      'AND guest.deleted_at IS NULL',
    ]) {
      expect(sql).toContain(kept);
    }
  });

  it('requires something made or uploaded, so the two lists never overlap', () => {
    expect(sql).toContain('AND ( EXISTS (SELECT 1 FROM public.generations AS generation_row WHERE generation_row.user_id = guest.id) OR EXISTS');
  });

  it('keeps public content and a recent creation out', () => {
    for (const table of ['posts AS post', 'post_comments AS post_comment', 'post_resource_bundles AS bundle', 'marketplace_assets AS listing', 'templates AS authored_template', 'workflow_shares AS workflow_share']) {
      expect(sql).toContain(`AND NOT EXISTS ( SELECT 1 FROM public.${table} WHERE`);
    }
    expect(sql).toContain('AND (recent_generation.created_at >= v_cutoff OR recent_generation.completed_at >= v_cutoff)');
  });
});
