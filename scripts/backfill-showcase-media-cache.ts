import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS } from '../src/lib/showcase-media-cache';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Rewrite every public Showcase object through the Storage API so its cache
 * header actually reaches viewers.
 *
 * `20260808120000_showcase_media_cache_ttl_backfill.sql` already set
 * `cacheControl` on these rows, and that was not enough: Supabase's CDN purges
 * an object's edge entry only when the object is written through the Storage
 * API, so a SQL metadata update changes what the origin would say and tells the
 * CDN nothing. Objects kept serving their previous header indefinitely --
 * verified after deploy, where derivatives still advertised a year and
 * originals five minutes, and neither `Cache-Control: no-cache` nor an unseen
 * query string could force a revalidation.
 *
 * Re-uploading identical bytes is therefore not a clumsy way to set metadata.
 * The write itself is the purge, and it is the only one available.
 *
 * Deliberately does NOT skip objects whose stored `cacheControl` already
 * matches the target: the migration made every row match, while the CDN did
 * not, and edge state is not observable from the database. Stored metadata is
 * not evidence of what is being served.
 */

const BUCKET = 'showcase_media';
const LIST_PAGE_SIZE = 100;
const TARGET_CACHE_CONTROL = String(SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS);

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const executionMode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(executionMode);

/**
 * `--limit=<n>` rewrites only the first n objects. Rewriting every public media
 * object at once is a wide blast radius for a content-type mistake, so the
 * intended first run is a single-object canary whose served header and rendered
 * bytes are checked before the rest follow. Also makes a partial run resumable
 * in the sense that re-running is safe -- the write is idempotent.
 */
function readLimitArgument(argv: string[]): number | null {
  const inline = argv.find((argument) => argument.startsWith('--limit='));
  const raw = inline ? inline.slice('--limit='.length) : null;
  if (raw === null) return null;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('--limit must be a positive integer.');
  }
  return parsed;
}

const objectLimit = readLimitArgument(process.argv.slice(2));

/**
 * `--verify` writes nothing and instead reports what the CDN actually serves.
 *
 * Stored metadata cannot answer this. The whole reason this script exists is
 * that the two can disagree, so the only honest check is a real request per
 * object. Note that an edge entry takes up to about a minute to reflect a
 * write, so verifying immediately after a rewrite will under-report.
 */
const verifyOnly = process.argv.slice(2).includes('--verify');

/**
 * There is deliberately NO remediation mode for stale ranged entries, because
 * none was found to work. Full and ranged requests hold separate edge entries
 * and a Storage write purges only the full one — verified on a controlled
 * scratch object and on live media, where a second rewrite left the ranged
 * entry serving a 7.7-day-old header against a 300s TTL. Delete looked like
 * the invalidator (the entry answers 4xx while the object is gone) but it
 * GATES rather than evicts: re-uploading to the same path brought the old
 * ranged variant back verbatim, twice, on live objects. Takedowns still work —
 * deleted content stops serving and stays deleted — but nothing available to
 * this script resets a warm ranged entry's headers while the object lives.
 * The full account is in F3 of docs/scaling-audit-2026-08-08.md.
 */

type StorageEntry = {
  path: string;
  mimeType: string | null;
  cacheControl: string | null;
  sizeBytes: number | null;
};

/**
 * Storage has no recursive listing, and the app's own tables would miss any
 * object they no longer reference, so this walks the tree. Supabase marks a
 * folder by returning it with a null id.
 */
async function* listBucketObjects(
  client: SupabaseClient,
  prefix = '',
): AsyncGenerator<StorageEntry> {
  let offset = 0;

  for (;;) {
    const { data, error } = await client.storage.from(BUCKET).list(prefix, {
      limit: LIST_PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;

    const entries = data ?? [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        yield* listBucketObjects(client, path);
        continue;
      }

      const metadata = (entry.metadata ?? {}) as {
        mimetype?: unknown;
        cacheControl?: unknown;
        size?: unknown;
      };
      yield {
        path,
        mimeType: typeof metadata.mimetype === 'string' ? metadata.mimetype : null,
        cacheControl: typeof metadata.cacheControl === 'string' ? metadata.cacheControl : null,
        sizeBytes: typeof metadata.size === 'number' ? metadata.size : null,
      };
    }

    if (entries.length < LIST_PAGE_SIZE) break;
    offset += entries.length;
  }
}

async function rewriteObject(entry: StorageEntry) {
  const download = await supabase.storage.from(BUCKET).download(entry.path);
  if (download.error || !download.data) {
    throw download.error ?? new Error('Storage returned no body.');
  }

  // The stored mimetype is authoritative; a downloaded Blob can arrive with an
  // empty type, and re-uploading that would relabel the object as binary.
  const contentType = entry.mimeType || download.data.type || 'application/octet-stream';
  const update = await supabase.storage.from(BUCKET).update(entry.path, download.data, {
    cacheControl: TARGET_CACHE_CONTROL,
    contentType,
    upsert: true,
  });
  if (update.error) throw update.error;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

async function main() {
  const discovered: StorageEntry[] = [];
  for await (const entry of listBucketObjects(supabase)) {
    discovered.push(entry);
  }

  const entries = objectLimit === null ? discovered : discovered.slice(0, objectLimit);
  if (objectLimit !== null) {
    console.log(`Limited to the first ${entries.length} of ${discovered.length} objects.`);
  }

  const totalBytes = entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const byCacheControl = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.cacheControl ?? '(none)';
    byCacheControl.set(key, (byCacheControl.get(key) ?? 0) + 1);
  }

  console.log(`Found ${entries.length} objects in ${BUCKET} (${formatMegabytes(totalBytes)}).`);
  console.log('Stored cacheControl, which is what the origin would answer:');
  for (const [value, count] of [...byCacheControl].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${value}: ${count}`);
  }
  console.log(`Target: max-age=${TARGET_CACHE_CONTROL}`);

  if (verifyOnly) {
    console.log('');
    console.log('Requesting each object to see what the CDN actually serves...');
    console.log('Both request shapes, because they hold separate edge entries: a full');
    console.log('GET and a ranged GET can answer differently for the same object, and');
    console.log('video players request with Range almost exclusively — a verify that');
    console.log('only sends full GETs reported this backfill green while playback was');
    console.log('still being served the old header.');
    const servedCounts = new Map<string, number>();
    const offTarget: string[] = [];

    for (const entry of entries) {
      const objectUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${entry.path}`;
      for (const [mode, headers] of [
        ['full', {}],
        ['ranged', { Range: 'bytes=0-0' }],
      ] as const) {
        const response = await fetch(objectUrl, { cache: 'no-store', headers });
        const served = response.headers.get('cache-control') ?? '(none)';
        const key = `${mode}: ${served}`;
        servedCounts.set(key, (servedCounts.get(key) ?? 0) + 1);
        if (!served.includes(`max-age=${TARGET_CACHE_CONTROL}`)) {
          offTarget.push(`${entry.path} [${mode}] -> ${served}`);
        }
      }
    }

    console.log('Served cache-control by request shape:');
    for (const [value, count] of [...servedCounts].sort((left, right) => right[1] - left[1])) {
      console.log(`  ${value}: ${count}`);
    }
    if (offTarget.length > 0) {
      console.log(`${offTarget.length} probe(s) not at the target:`);
      for (const line of offTarget.slice(0, 10)) console.log(`  ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(`All ${entries.length} objects serve max-age=${TARGET_CACHE_CONTROL} on full and ranged requests.`);
    return;
  }

  if (executionMode.dryRun) {
    console.log('');
    console.log(`Would download and re-upload all ${entries.length} objects, transferring`);
    console.log(`roughly ${formatMegabytes(totalBytes * 2)} in total, so that each write purges`);
    console.log('its own CDN entry. Stored metadata already matching the target is expected');
    console.log('and is not a reason to skip: the migration set it, the CDN never saw it.');
    return;
  }

  let rewritten = 0;
  const failures: Array<{ path: string; error: unknown }> = [];

  for (const [index, entry] of entries.entries()) {
    try {
      await rewriteObject(entry);
      rewritten += 1;
    } catch (error) {
      failures.push({ path: entry.path, error });
      console.error(`  failed: ${entry.path}`, error);
    }

    const position = index + 1;
    if (position % 25 === 0 || position === entries.length) {
      console.log(`  ${position}/${entries.length} processed (${rewritten} rewritten, ${failures.length} failed)`);
    }
  }

  console.log('');
  console.log(`Rewrote ${rewritten}/${entries.length} objects; ${failures.length} failed.`);
  console.log('Verify with a request that is not already cached at your edge:');
  console.log(`  curl -I "${supabaseUrl}/storage/v1/object/public/${BUCKET}/<path>"`);
  console.log(`  expect: cache-control: public, max-age=${TARGET_CACHE_CONTROL}`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
