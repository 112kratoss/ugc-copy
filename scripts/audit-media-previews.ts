/**
 * Read-only integrity audit, including rows marked ready (which repair skips).
 * npx tsx --env-file-if-exists=.env.local scripts/audit-media-previews.ts
 * --limit=200 bounds rows per table; --after=<uuid> resumes each table by id.
 * No media bytes, signed URLs, prompts, or credentials are written to disk.
 */
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { getStorageLocation } from '../src/lib/storage-path';

const args = process.argv.slice(2);
const limit = Number(args.find((arg) => arg.startsWith('--limit='))?.slice(8) ?? 200);
const after = args.find((arg) => arg.startsWith('--after='))?.slice(8);
if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
  throw new Error('--limit must be an integer between 1 and 2000.');
}
if (args.some((arg) => !arg.startsWith('--limit=') && !arg.startsWith('--after='))) {
  throw new Error('Only --limit and --after are supported. This audit never mutates data.');
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
};

async function main() {
  let generations = client.from('generations')
    .select('id,category,output_url,preview_url,preview_status')
    .eq('status', 'succeeded').order('id').limit(limit + 1);
  let posts = client.from('post_media')
    .select('id,media_kind,storage_path,external_url,preview_storage_path,preview_status')
    .order('id').limit(limit + 1);
  if (after) {
    generations = generations.gt('id', after);
    posts = posts.gt('id', after);
  }
  const [generationResult, postResult] = await Promise.all([generations, posts]);
  if (generationResult.error || postResult.error) throw new Error('Unable to read preview metadata.');

  const generationRows = generationResult.data ?? [];
  const postRows = postResult.data ?? [];
  const candidates: Candidate[] = [
    ...generationRows.slice(0, limit).map((row) => ({
      id: row.id, table: 'generations' as const, path: row.preview_url,
      status: row.preview_status, category: row.category, hasSource: Boolean(row.output_url),
    })),
    ...postRows.slice(0, limit).map((row) => ({
      id: row.id, table: 'post_media' as const,
      path: row.preview_storage_path ? `showcase_media/${row.preview_storage_path}` : null,
      status: row.preview_status, category: row.media_kind,
      hasSource: Boolean(row.storage_path || row.external_url),
    })),
  ];

  let index = 0;
  let decoded = 0;
  let bytesRead = 0;
  const findings: Array<{ table: string; id: string; issue: string; status: string | null }> = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < candidates.length) {
      const row = candidates[index++];
      const finding = (issue: string) => findings.push({ table: row.table, id: row.id, issue, status: row.status });
      if (!row.path) {
        if (row.category !== 'text' && row.category !== 'audio') {
          finding(row.hasSource ? 'missing_preview' : 'missing_source_and_preview');
        }
        continue;
      }
      const location = getStorageLocation(row.path);
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
  const moreGenerations = generationRows.length > limit;
  const morePosts = postRows.length > limit;
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(), readOnly: true, rows: candidates.length,
    decoded, bytesRead, findings,
    complete: !moreGenerations && !morePosts,
    // Use the earlier cursor so neither independently paged table loses rows.
    nextAfter: moreGenerations || morePosts
      ? [moreGenerations ? generationRows[limit - 1].id : null,
        morePosts ? postRows[limit - 1].id : null].filter((id): id is string => Boolean(id)).sort()[0]
      : null,
  }, null, 2));
  if (findings.length || moreGenerations || morePosts) process.exitCode = 1;
}

main().catch(() => {
  console.error('Media audit failed. Check operator credentials, connectivity, and schema.');
  process.exitCode = 1;
});
