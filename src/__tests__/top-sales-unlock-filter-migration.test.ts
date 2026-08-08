import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260808150000_top_sales_unlock_filter.sql',
), 'utf8');

describe('top sales unlock filter migration', () => {
  it('drops the four-parameter signature before creating the five-parameter one', () => {
    // Left as an overload, PostgREST would match a four-argument call against
    // both functions (the new one via its default) and reject it as ambiguous,
    // taking down the endpoint the fast path serves.
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.list_showcase_top_sales_post_ids(text, text, integer, integer);',
    );
    expect(migration.indexOf('DROP FUNCTION'))
      .toBeLessThan(migration.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(migration).toContain("p_unlock_filter text DEFAULT 'all'");
  });

  it('mirrors the app-side unlock predicates exactly', () => {
    // with-unlock = a published bundle exists; free/paid = its access mode.
    // The join is already restricted to published bundles.
    expect(migration).toContain("coalesce(p_unlock_filter, 'all') = 'all'");
    expect(migration).toContain("p_unlock_filter = 'with-unlock' AND bundles.post_id IS NOT NULL");
    expect(migration).toContain("p_unlock_filter IN ('free', 'paid') AND bundles.access_mode = p_unlock_filter");
  });

  it('leaves resource-kind filtering out of SQL', () => {
    // getPostResourceKinds is a multi-fallback derivation over resource JSON;
    // duplicating it here would fork business logic. The app streams these ids
    // and filters in JS, stopping early because the order is already global.
    expect(migration).not.toMatch(/resource_kind|resource_items|p_resource/i);
  });

  it('keeps the ordering and visibility guards of the function it replaces', () => {
    // Pagination stability depends on this exact order; a drifted tie-break
    // would repeat or skip items across pages.
    expect(migration).toContain('coalesce(bundles.sales_count, 0) DESC');
    expect(migration).toContain('posts.created_at DESC');
    expect(migration).toContain("posts.visibility = 'public'");
    expect(migration).toContain("coalesce(posts.review_status, 'visible') = 'visible'");
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path = ''");
  });

  it('grants the new signature to the service role only', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer, text) FROM anon, authenticated;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer, text) TO service_role;',
    );
  });
});
