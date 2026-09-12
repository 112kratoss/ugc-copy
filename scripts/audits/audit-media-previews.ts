/**
 * Read-only integrity audit, including rows marked ready (which repair skips).
 * npx tsx --env-file-if-exists=.env.local scripts/audits/audit-media-previews.ts
 * --limit=200 bounds rows per table; --after=<uuid> resumes each table by id.
 * --sample=<n> checks n rows drawn from across the corpus instead of the next
 * page, which is what a periodic health check wants: a bounded, representative
 * download rather than a full re-read of every preview.
 * No media bytes, signed URLs, prompts, or credentials are written to disk.
 *
 * Exit status is a health signal, not a progress one: 1 means something is
 * actually broken. A run that leaves pages unread is reported through
 * `complete: false` and still exits 0, because "there is more to look at" is
 * not the same as "something is wrong" — conflating them was why this could
 * never report clean.
 *
 * Records whose only source is gone (`source_unavailable_at`, set by the
 * repair job after a second 404/410) are counted separately and are not
 * findings. They have no preview and never will; reporting them as failures
 * meant the audit stayed red forever over three rows nothing can fix.
 */
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import {
  classifyPreviewCandidate,
  drawIntegritySample,
} from '../../src/lib/media-integrity-audit';
import { getStorageLocation } from '../../src/lib/storage-path';

const args = process.argv.slice(2);
const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.slice(8) ?? 200);
const after = args.find((arg) => arg.startsWith('--after='))?.slice(8);
const sampleArgument = args.find((arg) => arg.startsWith('--sample='))?.slice(9);
const sample = sampleArgument === undefined ? null : Number(sampleArgument);
if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
  throw new Error('--limit must be an integer between 1 and 2000.');
}
if (sample !== null && (!Number.isInteger(sample) || sample < 1 || sample > 500)) {
  throw new Error('--sample must be an integer between 1 and 500.');
}
if (sample !== null && after) {
  throw new Error('--sample draws from the whole corpus, so it cannot be combined with --after.');
}
if (args.some((arg) => !arg.startsWith('--limit=') && !arg.startsWith('--after=') && !arg.startsWith('--sample='))) {
  throw new Error('Only --limit, --after and --sample are supported. This audit never mutates data.');
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing Supabase URL or service-role key.');
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    }),
  },
});

type Candidate = {
  id: string;
  table: 'generations' | 'post_media';
  path: string | null;
  status: string | null;
  category: string | null;
  hasSource: boolean;
  sourceUnavailable: boolean;
};

async function main() {
  const pageSize = sample ?? limit;
  let generations = client.from('generations')
    .select('id,category,output_url,preview_url,preview_status,source_unavailable_at')
    .eq('status', 'succeeded').order('id').limit(sample ? 2000 : pageSize + 1);
  let posts = client.from('post_media')
    .select('id,media_kind,storage_path,external_url,preview_storage_path,preview_status,source_unavailable_at')
    .order('id').limit(sample ? 2000 : pageSize + 1);
  if (after) {
    generations = generations.gt('id', after);
    posts = posts.gt('id', after);
  }
  const [generationResult, postResult] = await Promise.all([generations, posts]);
  if (generationResult.error || postResult.error) throw new Error('Unable to read preview metadata.');

  const generationRows = generationResult.data ?? [];
  const postRows = postResult.data ?? [];
  const generationsToCheck = sample
    ? drawIntegritySample(generationRows, sample)
    : generationRows.slice(0, pageSize);
  const postsToCheck = sample ? drawIntegritySample(postRows, sample) : postRows.slice(0, pageSize);
  const candidates: Candidate[] = [
    ...generationsToCheck.map((row) => ({
      id: row.id, table: 'generations' as const, path: row.preview_url,
      status: row.preview_status, category: row.category, hasSource: Boolean(row.output_url),
      sourceUnavailable: Boolean(row.source_unavailable_at),
    })),
    ...postsToCheck.map((row) => ({
      id: row.id, table: 'post_media' as const,
      path: row.preview_storage_path ? `showcase_media/${row.preview_storage_path}` : null,
      status: row.preview_status, category: row.media_kind,
      hasSource: Boolean(row.storage_path || row.external_url),
      sourceUnavailable: Boolean(row.source_unavailable_at),
    })),
  ];

  let index = 0;
  let decoded = 0;
  let bytesRead = 0;
  const findings: Array<{ table: string; id: string; issue: string; status: string | null }> = [];
  const knownUnavailable: Array<{ table: string; id: string }> = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < candidates.length) {
      const row = candidates[index++];
      const finding = (issue: string) => findings.push({ table: row.table, id: row.id, issue, status: row.status });
      const verdict = classifyPreviewCandidate(row);
      if (verdict.kind === 'source_unavailable') {
        // Counted rather than reported: the product already renders these as
        // explicitly unavailable, and failing on them kept the audit red over
        // records nothing can fix.
        knownUnavailable.push({ table: row.table, id: row.id });
        continue;
      }
      if (verdict.kind === 'not_applicable') continue;
      if (verdict.kind === 'finding') {
        finding(verdict.issue);
        continue;
      }
      const location = getStorageLocation(verdict.path);
      if (!location) {
        finding('noncanonical_preview_path');
        continue;
      }
      try {
        const result = await client.storage.from(location.bucket).download(location.filePath);
        if (result.error || !result.data) {
          finding('storage_read_failed');
          continue;
        }
        bytesRead += result.data.size;
        if (result.data.size > 5 * 1024 * 1024) {
          finding('oversized_preview');
          continue;
        }
        // metadata() and a RIFF signature can succeed without decoding pixels.
        // stats() forces a full decode; the production corrupt WebP fails here.
        const bytes = Buffer.from(await result.data.arrayBuffer());
        const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
        await image.stats();
        decoded += 1;
        const metadata = await image.metadata();
        if (Math.max(metadata.width ?? 0, metadata.height ?? 0) > 720) {
          finding('preview_exceeds_720px');
        }
      } catch {
        finding('unreadable_or_undecodable_preview');
      }
    }
  }));

  findings.sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
  knownUnavailable.sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
  const moreGenerations = !sample && generationRows.length > pageSize;
  const morePosts = !sample && postRows.length > pageSize;
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(), readOnly: true, rows: candidates.length,
    mode: sample ? 'sample' : 'page',
    decoded, bytesRead, findings,
    // Not failures: recorded so an operator can see the count did not drift.
    knownUnavailable,
    complete: !moreGenerations && !morePosts,
    // Use the earlier cursor so neither independently paged table loses rows.
    nextAfter: moreGenerations || morePosts
      ? [moreGenerations ? generationRows[pageSize - 1].id : null,
        morePosts ? postRows[pageSize - 1].id : null].filter((id): id is string => Boolean(id)).sort()[0]
      : null,
  }, null, 2));
  // Health, not progress: unread pages are reported, never failed on.
  if (findings.length) process.exitCode = 1;
}

main().catch(() => {
  console.error('Media audit failed. Check operator credentials, connectivity, and schema.');
  process.exitCode = 1;
});
