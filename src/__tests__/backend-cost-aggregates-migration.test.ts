import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809200000_backend_cost_aggregates.sql',
), 'utf8');

describe('backend cost aggregates migration', () => {
  it('keeps budget thresholds and scope classification out of SQL', () => {
    // F15a moves arithmetic into the database, not policy. Which scopes count
    // as a media read changes whenever a route is added, and
    // MEDIA_READ_RATE_LIMIT_SCOPES in backend-cost-report.ts is the single
    // place that knows. A copy here would fork silently: the migration cannot
    // be edited without a deploy, so the two would drift and the report would
    // start under-counting media reads with nothing failing.
    expect(migration).not.toContain('media-read:sign');
    expect(migration).not.toContain('generation-model:quote');
    expect(migration).not.toContain('showcase-preview:read-url');
    expect(migration).toContain("'byScope'");
  });

  it('takes the storage bucket list as a parameter rather than hard-coding it', () => {
    // This one has to be a filter or the function scans every bucket, so it is
    // passed in from GENERATED_STORAGE_BUCKETS instead of duplicated.
    expect(migration).toContain('p_storage_buckets text[]');
    expect(migration).toContain('rows.bucket_id = ANY (coalesce(p_storage_buckets, ARRAY[]::text[]))');
    expect(migration).not.toContain("'generated_videos'");
  });

  it('omits zero-count keys from the failure and timeout breakdowns', () => {
    // The JS only calls incrementCount on an actual failure, so a service with
    // no timeouts has no key at all. `count(*) FILTER (WHERE ...)` grouped by
    // service would emit {"razorpay": 0} instead — arithmetically nicer, and a
    // silent behaviour change in every consumer that iterates these objects.
    expect(migration).toContain("WHERE outcome <> 'success' GROUP BY service_name");
    expect(migration).toContain("WHERE outcome = 'timeout' GROUP BY service_name");
    expect(migration).not.toMatch(/count\(\*\)\s*FILTER/i);
  });

  it('clamps negative values and treats a null grouping key as unknown', () => {
    // Mirrors numericValue() and `?? 'unknown'`. Note `??` catches null but not
    // the empty string, and coalesce behaves the same way — a row with
    // `status = ''` must group under '' in both paths.
    expect(migration).toContain("coalesce(rows.status, 'unknown')");
    expect(migration).toContain('greatest(coalesce(rows.cost, 0), 0)');
    expect(migration).toContain('greatest(coalesce(rows.duration_ms, 0), 0)');
  });

  it('counts an output only when the url is non-null AND non-empty', () => {
    // JS string truthiness: '' is falsy, so an empty output_url is not an
    // output. It is deliberately not trimmed, because ' ' IS truthy in JS.
    expect(migration).toContain("rows.output_url IS NOT NULL AND rows.output_url <> ''");
    expect(migration).not.toContain('btrim(rows.output_url)');
  });

  it('reads a non-numeric metadata size as zero instead of raising', () => {
    // storage.objects.metadata is untyped jsonb written by the storage service.
    // An unguarded `(metadata->>'size')::numeric` throws on one malformed row
    // and takes the entire cost report down with it — the JS returns 0.
    expect(migration).toContain("jsonb_typeof(rows.metadata) <> 'object'");
    expect(migration).toContain("jsonb_typeof(rows.metadata -> 'size') = 'number'");
    expect(migration).toContain("~ '^-?\\d+(\\.\\d+)?$'");
  });

  it('is readable only by the service role', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) FROM anon');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_backend_cost_aggregates(timestamptz, text[], integer) TO service_role');
  });
});
