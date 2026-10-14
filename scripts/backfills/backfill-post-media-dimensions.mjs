import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

/**
 * Fills `post_media.width` / `height` on rows that have no usable size.
 *
 * Both clients lay a feed card out from its cover's size before the image
 * arrives. A row without one is placed at a guessed height and resized once the
 * client has measured the image, under the reader (product decision D8, finding
 * 05-6 of the 2026-10-13 Home / Explore comparison). Rows go without a size when
 * they predate the measuring (the June 2026 gallery backfill, the September
 * cover backfill), when the preview sweep never measured them (an
 * `external_url` row, a preview that failed for good), or when a video's
 * rendition was skipped: the rendition sweep is the only writer of a video's size.
 *
 * Where a size comes from, cheapest first, and never by downloading a video:
 * - image: the stored file's header (its first 64 KB; the whole file only when
 *   sharp cannot read a header alone, as with WebP and GIF), then the linked
 *   generation's recorded preview size when the row is that generation's output;
 * - video: the linked generation's recorded preview size, then the row's own
 *   poster (a small WebP).
 * A row with nothing to read from is skipped and counted. A preview or a poster
 * is a `fit: inside` resize, so it has the right ratio at a smaller scale, and
 * the ratio is all a layout reads from these columns.
 *
 * Files are located the way `src/lib/post-media.ts` resolves them, with the
 * preview sweep's scope checks: a `storage_path` only under its own post's
 * prefix (or its generation's `showcase/` prefix), an `external_url` only as
 * storage owned by the post's creator. Any other address is never fetched.
 *
 * Exactly one mode is required; without one nothing is read:
 *   --dry-run  counts the rows by media kind, prints five, and tallies what
 *              --apply would read for each (database fields only, no file read)
 *   --apply    measures and writes in batches of 100, one log line per batch
 * A write lands only on a row still missing its size, so a sweep's fresher
 * measurement is never overwritten, and a second run finds only the rows this
 * one could not size.
 *
 * Run from the primary checkout, whose .env.local holds the service key
 * (nothing secret is printed):
 *   node --env-file-if-exists=.env.local scripts/backfills/backfill-post-media-dimensions.mjs --dry-run
 */

export const BATCH_SIZE = 100;
const SAMPLE_SIZE = 5;
const HEADER_BYTES = 64 * 1024;
// Uploads cap an image at 25 MB; the margin covers a legacy object or two.
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const SIGNED_URL_TTL_SECONDS = 120;
const CONCURRENCY = 6;
const NULL_SIZE_FILTER = 'width.is.null,height.is.null';
const CANDIDATE_COLUMNS = 'id, post_id, media_kind, storage_path, external_url, preview_storage_path, sort_order, width, height, source_unavailable_at, posts!inner(user_id, generation_id)';
// The buckets `getUserOwnedStoredMediaLocation` accepts for a creator's file.
const USER_SCOPED_BUCKETS = new Set([
  'uploads',
  'generated_images',
  'generated_videos',
  'generated_audio',
  'generation_inputs',
  'profiles',
  'post_resource_files',
  'template_inputs',
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export const USAGE = [
  'Usage: node --env-file-if-exists=.env.local scripts/backfills/backfill-post-media-dimensions.mjs (--dry-run | --apply)',
  '  --dry-run  report the rows without a size and what --apply would read; writes nothing',
  '  --apply    measure and write the sizes, in batches of 100',
].join('\n');

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {'dry-run' | 'apply'}
 */
export function parseMode(argv) {
  const unknown = argv.filter((argument) => argument !== '--dry-run' && argument !== '--apply');
  if (unknown.length > 0) {
    throw new UsageError(`Unknown argument ${unknown.join(' ')}; nothing was read or written.`);
  }
  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  if (dryRun && apply) {
    throw new UsageError('Choose --dry-run or --apply, not both; nothing was read or written.');
  }
  if (!dryRun && !apply) {
    throw new UsageError('No mode given, so nothing was read or written: pass --dry-run to report or --apply to write.');
  }
  return apply ? 'apply' : 'dry-run';
}

/**
 * The rule `toUsablePreviewSize` (src/lib/preview-dimensions.ts) applies: a
 * ratio is the consumer, so half a size, a zero or a non-number is no size.
 *
 * @param {unknown} width
 * @param {unknown} height
 * @returns {{ width: number, height: number } | null}
 */
export function toUsableSize(width, height) {
  /** @param {unknown} value */
  const usable = (value) => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
  );
  const usableWidth = usable(width);
  const usableHeight = usable(height);
  return usableWidth && usableHeight ? { width: usableWidth, height: usableHeight } : null;
}

/**
 * The displayed size of an image from its bytes, or null when they hold no
 * header sharp can read. The head of a JPEG, PNG or AVIF is enough; WebP and
 * GIF need the whole file. EXIF orientation is applied: a phone photo stored
 * landscape with orientation 6 is shown portrait, and must be laid out so.
 *
 * @param {Uint8Array} bytes
 */
export async function readImageSize(bytes) {
  if (!bytes || bytes.length === 0) return null;
  try {
    const metadata = await sharp(bytes).metadata();
    const oriented = metadata.autoOrient ?? metadata;
    return toUsableSize(oriented.width, oriented.height);
  } catch {
    return null;
  }
}

/** @param {unknown} path */
function canonicalObjectPath(path, minimumSegments = 2) {
  if (
    typeof path !== 'string'
    || !path
    || path !== path.trim()
    // Stricter than the app's decoder: any escape is refused rather than decoded.
    || path.includes('%')
    || path.startsWith('/')
    || path.endsWith('/')
    || path.includes('\\')
    || path.includes('://')
    || CONTROL_CHARACTER.test(path)
  ) return null;
  const segments = path.split('/');
  if (segments.length < minimumSegments || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return path;
}

/** `postMediaStorageBucket` in src/lib/post-media-storage.ts. @param {string} path */
export function postMediaBucket(path) {
  return path.startsWith('private-posts/') ? 'post_media' : 'showcase_media';
}

/**
 * A `post_media` path only where the preview sweep would read it
 * (`getCanonicalPostMediaPath` in src/lib/media-preview-repair.ts): under the
 * post's own prefix, or under its generation's `showcase/` prefix.
 *
 * @param {unknown} path
 * @param {{ postId: string, generationId: string | null }} scope
 * @returns {{ bucket: string, path: string } | null}
 */
export function scopedPostMediaLocation(path, scope) {
  const canonical = canonicalObjectPath(path, 3);
  if (!canonical) return null;
  const [namespace, scopedId] = canonical.split('/');
  const inScope = namespace === 'posts' || namespace === 'private-posts'
    ? scopedId === scope.postId
    : namespace === 'showcase' && Boolean(scope.generationId) && scopedId === scope.generationId;
  return inScope ? { bucket: postMediaBucket(canonical), path: canonical } : null;
}

/** @param {string} value @param {string} ownerUserId */
function ownedBucketPath(value, ownerUserId) {
  const separator = value.indexOf('/');
  if (separator <= 0) return null;
  const bucket = value.slice(0, separator);
  if (!USER_SCOPED_BUCKETS.has(bucket)) return null;
  const path = canonicalObjectPath(value.slice(separator + 1));
  return path && path.split('/')[0] === ownerUserId ? { bucket, path } : null;
}

/**
 * An `external_url` as storage owned by the post's creator, the only form
 * `resolveOwnedStoredMediaUrl` signs: `bucket/owner/...`, or a Supabase storage
 * URL naming one. The raw path is read from the string, never from
 * URL.pathname, which would normalise away a `..` this check must see.
 *
 * @param {unknown} value
 * @param {string | null | undefined} ownerUserId
 * @returns {{ bucket: string, path: string } | null}
 */
export function ownedStorageLocation(value, ownerUserId) {
  if (typeof value !== 'string' || !value || !ownerUserId) return null;
  const direct = ownedBucketPath(value, ownerUserId);
  if (direct) return direct;

  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  } catch {
    return null;
  }
  const pathStart = value.indexOf('/', value.indexOf('://') + 3);
  if (pathStart < 0) return null;
  const ends = [value.indexOf('?', pathStart), value.indexOf('#', pathStart)].filter((index) => index >= 0);
  const rawPath = value.slice(pathStart, ends.length > 0 ? Math.min(...ends) : value.length);
  const match = rawPath.match(/^\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
  return match ? ownedBucketPath(`${match[1]}/${match[2]}`, ownerUserId) : null;
}

/** @param {any} row */
function embeddedPost(row) {
  const post = Array.isArray(row?.posts) ? row.posts[0] : row?.posts;
  return {
    userId: typeof post?.user_id === 'string' ? post.user_id : null,
    generationId: typeof post?.generation_id === 'string' ? post.generation_id : null,
  };
}

/**
 * Whether the row holds its post's generation output, the case where that
 * generation's preview describes it: the cover of a generation-backed post,
 * kept as the generation's own address (the June gallery backfill copied the
 * post's output URL) or as its public derivative under `showcase/<generation>/`.
 *
 * @param {any} row
 * @param {string | null} generationId
 */
function isGenerationOutput(row, generationId) {
  if (!generationId || row.sort_order !== 0) return false;
  if (!row.storage_path) return Boolean(row.external_url);
  return typeof row.storage_path === 'string' && row.storage_path.startsWith(`showcase/${generationId}/`);
}

/** @param {any} row @param {{ userId: string | null, generationId: string | null }} post */
function sourceFileLocation(row, post) {
  if (row.storage_path) {
    const location = scopedPostMediaLocation(row.storage_path, { postId: row.post_id, generationId: post.generationId });
    return location ? { location } : { reason: 'path-outside-post-prefix' };
  }
  if (row.external_url) {
    const location = ownedStorageLocation(row.external_url, post.userId);
    if (location) return { location };
    // A storage address the app would not sign is served by nobody; a
    // provider's address is never fetched from here.
    const remote = /^https?:\/\//i.test(row.external_url) && !row.external_url.includes('/storage/v1/object/');
    return { reason: remote ? 'remote-url' : 'unreadable-address' };
  }
  return { reason: 'no-address' };
}

/**
 * @typedef {{ type: 'generation', size: { width: number, height: number } }
 *   | { type: 'file' | 'poster', location: { bucket: string, path: string }, maxBytes: number }} SizeSource
 */

/**
 * What to read for one row, in order; the first source that answers wins.
 * Pure (database fields only), so a dry run can report it without reading a file.
 *
 * @param {any} row a candidate row with its post embedded as `posts`
 * @param {{ preview_width?: unknown, preview_height?: unknown } | null | undefined} generation
 * @returns {{ sources: SizeSource[], reason: string | null }}
 */
export function planRow(row, generation) {
  if (toUsableSize(row.width, row.height)) return { sources: [], reason: 'already-sized' };
  if (row.source_unavailable_at) return { sources: [], reason: 'source-unavailable' };

  const post = embeddedPost(row);
  const generationSize = isGenerationOutput(row, post.generationId)
    ? toUsableSize(generation?.preview_width, generation?.preview_height)
    : null;
  /** @type {SizeSource[]} */
  const fromGeneration = generationSize ? [{ type: 'generation', size: generationSize }] : [];

  if (row.media_kind === 'image') {
    const file = sourceFileLocation(row, post);
    /** @type {SizeSource[]} */
    const sources = [
      ...(file.location ? [{ type: /** @type {const} */ ('file'), location: file.location, maxBytes: MAX_IMAGE_BYTES }] : []),
      ...fromGeneration,
    ];
    return { sources, reason: sources.length > 0 ? null : file.reason ?? 'no-address' };
  }

  if (row.media_kind === 'video') {
    const poster = row.preview_storage_path
      ? scopedPostMediaLocation(row.preview_storage_path, { postId: row.post_id, generationId: post.generationId })
      : null;
    /** @type {SizeSource[]} */
    const sources = [
      ...fromGeneration,
      ...(poster ? [{ type: /** @type {const} */ ('poster'), location: poster, maxBytes: MAX_POSTER_BYTES }] : []),
    ];
    return { sources, reason: sources.length > 0 ? null : 'video-without-poster' };
  }

  return { sources: [], reason: 'unknown-media-kind' };
}

/**
 * Reads up to `maxBytes` of an object. With `range`, asks for just that much;
 * a server that ignores the header and sends everything is cut off at the same
 * point either way. `complete` says whether the object ended inside the bytes.
 *
 * @param {string} url
 * @param {{ maxBytes: number, range: boolean, fetchImpl?: typeof fetch }} options
 */
export async function readObjectBytes(url, { maxBytes, range, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    headers: range ? { Range: `bytes=0-${maxBytes - 1}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    // The status only: the address may carry a signing token.
    throw new Error(`storage answered HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let received = 0;
  let ended = false;
  while (received < maxBytes) {
    const next = await reader.read();
    if (next.done) {
      ended = true;
      break;
    }
    chunks.push(next.value);
    received += next.value.byteLength;
  }
  if (!ended) await reader.cancel();
  if (!range && !ended) throw new Error(`object is larger than ${maxBytes} bytes`);

  const contentRange = /^bytes \d+-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const complete = ended && (response.status !== 206 || (contentRange !== null && Number(contentRange[1]) + 1 === Number(contentRange[2])));
  return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), complete };
}

/**
 * Storage reads through the service client: the public bucket by its public
 * URL, the private ones by a short-lived signed URL that is never printed.
 *
 * @param {any} supabase
 * @param {typeof fetch} [fetchImpl]
 */
export function createStorageIo(supabase, fetchImpl = fetch) {
  return {
    /**
     * @param {{ bucket: string, path: string }} location
     * @param {{ maxBytes: number, range: boolean }} options
     */
    async readObject(location, options) {
      let url;
      if (location.bucket === 'showcase_media') {
        url = supabase.storage.from(location.bucket).getPublicUrl(location.path).data.publicUrl;
      } else {
        const { data, error } = await supabase.storage
          .from(location.bucket)
          .createSignedUrl(location.path, SIGNED_URL_TTL_SECONDS);
        if (error || !data?.signedUrl) throw new Error(`could not sign the object: ${describe(error)}`);
        url = data.signedUrl;
      }
      return readObjectBytes(url, { ...options, fetchImpl });
    },
  };
}

/**
 * @param {{ bucket: string, path: string }} location
 * @param {number} maxBytes
 * @param {{ readObject: (location: { bucket: string, path: string }, options: { maxBytes: number, range: boolean }) => Promise<{ bytes: Uint8Array, complete: boolean }> }} io
 */
async function measureStoredImage(location, maxBytes, io) {
  const head = await io.readObject(location, { maxBytes: Math.min(HEADER_BYTES, maxBytes), range: true });
  const fromHead = await readImageSize(head.bytes);
  if (fromHead || head.complete) return fromHead;
  return readImageSize((await io.readObject(location, { maxBytes, range: false })).bytes);
}

/**
 * @param {{ sources: SizeSource[] }} plan
 * @param {Parameters<typeof measureStoredImage>[2]} io
 * @returns {Promise<{ size: { width: number, height: number }, source: string } | { size: null, error: string }>}
 */
export async function measureRow(plan, io) {
  let error = 'no source answered';
  for (const source of plan.sources) {
    if (source.type === 'generation') return { size: source.size, source: 'generation' };
    try {
      const size = await measureStoredImage(source.location, source.maxBytes, io);
      if (size) return { size, source: source.type };
      error = `${source.type}: no readable image header`;
    } catch (caught) {
      error = `${source.type}: ${describe(caught)}`;
    }
  }
  return { size: null, error };
}

/** @param {any} supabase @param {{ afterId: string | null, limit: number }} page */
export async function readCandidatePage(supabase, { afterId, limit }) {
  let query = supabase.from('post_media').select(CANDIDATE_COLUMNS).or(NULL_SIZE_FILTER);
  if (afterId) query = query.gt('id', afterId);
  const { data, error } = await query.order('id', { ascending: true }).limit(limit);
  if (error) throw error;
  return /** @type {any[]} */ (data ?? []);
}

/** @param {any} supabase @param {any[]} rows */
async function readGenerations(supabase, rows) {
  const ids = [...new Set(rows.map((row) => embeddedPost(row).generationId).filter(Boolean))];
  /** @type {Map<string, any>} */
  const generations = new Map();
  if (ids.length === 0) return generations;
  const { data, error } = await supabase.from('generations').select('id, preview_width, preview_height').in('id', ids);
  if (error) throw error;
  for (const generation of data ?? []) generations.set(generation.id, generation);
  return generations;
}

/** @param {any} supabase */
async function countCandidates(supabase) {
  /** @param {string | null} kind */
  const count = async (kind) => {
    let query = supabase.from('post_media').select('id', { count: 'exact', head: true }).or(NULL_SIZE_FILTER);
    if (kind) query = query.eq('media_kind', kind);
    const { count: rows, error } = await query;
    if (error) throw error;
    return rows ?? 0;
  };
  const [total, image, video] = await Promise.all([count(null), count('image'), count('video')]);
  return { total, image, video };
}

/**
 * Only where the row still has no size: a sweep that measured it meanwhile
 * read fresher bytes, and a second run must find nothing to change.
 *
 * @param {any} supabase
 * @param {string} rowId
 * @param {{ width: number, height: number }} size
 */
export async function writeSize(supabase, rowId, size) {
  const { data, error } = await supabase
    .from('post_media')
    .update({ width: size.width, height: size.height })
    .eq('id', rowId)
    .or(NULL_SIZE_FILTER)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/**
 * Supabase errors are plain objects, so `String(error)` prints
 * `[object Object]`; read the shape instead.
 *
 * @param {unknown} error
 */
function describe(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { message, code } = /** @type {{ message?: unknown, code?: unknown }} */ (error);
    const parts = [typeof message === 'string' ? message : null, typeof code === 'string' ? `(${code})` : null].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
  }
  return String(error);
}

/** An address for the log with any query string (a signing token) removed. @param {unknown} value */
function printableAddress(value) {
  if (typeof value !== 'string') return '-';
  const cut = value.search(/[?#]/);
  return cut >= 0 ? `${value.slice(0, cut)}?…` : value;
}

/** "remote-url 3, no-address 1", largest first. @param {Map<string, number>} counts */
function formatTally(counts) {
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([key, value]) => `${key} ${value}`).join(', ');
}

/** @param {Map<string, number>} counts @param {string} key */
function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} work
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, work) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

/**
 * @param {{
 *   supabase: any,
 *   mode: 'dry-run' | 'apply',
 *   io?: Parameters<typeof measureStoredImage>[2],
 *   logger?: { log: (line: string) => void },
 * }} options
 */
export async function runBackfill({ supabase, mode, io = createStorageIo(supabase), logger = console }) {
  const counts = await countCandidates(supabase);
  const other = counts.total - counts.image - counts.video;
  logger.log(`post_media rows without a usable size: ${counts.total} (image ${counts.image}, video ${counts.video}${other > 0 ? `, other ${other}` : ''})`);

  const sample = await readCandidatePage(supabase, { afterId: null, limit: SAMPLE_SIZE });
  if (sample.length > 0) logger.log(`First ${sample.length}:`);
  for (const row of sample) {
    const address = row.storage_path ? `storage_path ${row.storage_path}` : `external_url ${printableAddress(row.external_url)}`;
    logger.log(`  ${row.id}  post ${row.post_id}  ${row.media_kind}  ${address}`);
  }

  const totals = { rows: 0, updated: 0, skipped: 0, failed: 0 };
  const firstSources = new Map();
  const updatedBySource = new Map();
  const skipReasons = new Map();
  const failReasons = new Map();
  let afterId = null;
  let batchNumber = 0;

  for (;;) {
    const rows = await readCandidatePage(supabase, { afterId, limit: BATCH_SIZE });
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    batchNumber += 1;
    totals.rows += rows.length;
    const generations = await readGenerations(supabase, rows);
    const plans = rows.map((row) => planRow(row, generations.get(embeddedPost(row).generationId ?? '')));

    if (mode === 'dry-run') {
      plans.forEach((plan, index) => {
        if (plan.sources.length > 0) bump(firstSources, `${rows[index].media_kind}: ${plan.sources[0].type}`);
        else bump(skipReasons, plan.reason ?? 'unknown');
      });
    } else {
      const outcomes = await mapWithConcurrency(rows.map((row, index) => ({ row, plan: plans[index] })), async ({ row, plan }) => {
        if (plan.sources.length === 0) return { status: 'skipped', reason: plan.reason ?? 'unknown' };
        const measured = await measureRow(plan, io);
        if (!measured.size) return { status: 'failed', reason: measured.error };
        try {
          return await writeSize(supabase, row.id, measured.size)
            ? { status: 'updated', reason: measured.source }
            : { status: 'skipped', reason: 'sized-meanwhile' };
        } catch (error) {
          return { status: 'failed', reason: `update: ${describe(error)}` };
        }
      });

      const batch = { updated: 0, skipped: new Map(), failed: new Map() };
      for (const outcome of outcomes) {
        if (outcome.status === 'updated') {
          batch.updated += 1;
          bump(updatedBySource, outcome.reason);
        } else {
          bump(outcome.status === 'skipped' ? batch.skipped : batch.failed, outcome.reason);
          bump(outcome.status === 'skipped' ? skipReasons : failReasons, outcome.reason);
        }
      }
      const skipped = [...batch.skipped.values()].reduce((sum, value) => sum + value, 0);
      const failed = [...batch.failed.values()].reduce((sum, value) => sum + value, 0);
      totals.updated += batch.updated;
      totals.skipped += skipped;
      totals.failed += failed;
      logger.log(
        `batch ${batchNumber}: ${rows.length} rows · updated ${batch.updated}`
        + ` · skipped ${skipped}${skipped > 0 ? ` (${formatTally(batch.skipped)})` : ''}`
        + ` · failed ${failed}${failed > 0 ? ` (${formatTally(batch.failed)})` : ''}`,
      );
    }

    if (rows.length < BATCH_SIZE) break;
  }

  if (mode === 'dry-run') {
    const skipped = [...skipReasons.values()].reduce((sum, value) => sum + value, 0);
    totals.skipped = skipped;
    logger.log('What --apply would read first (database fields only; a dry run reads no file):');
    logger.log(`  ${firstSources.size > 0 ? formatTally(firstSources) : 'nothing'}`);
    logger.log(`  nothing to read from: ${skipped}${skipped > 0 ? ` (${formatTally(skipReasons)})` : ''}`);
    logger.log('Dry run: nothing was written. Re-run with --apply to write.');
  } else {
    logger.log(
      `Done: ${totals.rows} rows · updated ${totals.updated}${totals.updated > 0 ? ` (${formatTally(updatedBySource)})` : ''}`
      + ` · skipped ${totals.skipped}${totals.skipped > 0 ? ` (${formatTally(skipReasons)})` : ''}`
      + ` · failed ${totals.failed}${totals.failed > 0 ? ` (${formatTally(failReasons)})` : ''}`,
    );
  }

  return { mode, counts, ...totals };
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   createSupabase?: (url: string, key: string) => any,
 *   logger?: { log: (line: string) => void, error: (line: string) => void },
 * }} [options]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = process.argv.slice(2), {
  env = process.env,
  createSupabase = (url, key) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
  logger = console,
} = {}) {
  let mode;
  try {
    mode = parseMode(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    logger.error(error.message);
    logger.error(USAGE);
    return 2;
  }

  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    logger.error('Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY; nothing was read.');
    return 2;
  }

  let host = 'an unparseable URL';
  try {
    host = new URL(supabaseUrl).host;
  } catch {
    // Reported as unparseable; createClient rejects it below.
  }
  logger.log(mode === 'apply'
    ? `APPLY: writing post_media sizes on ${host}.`
    : `DRY RUN: reading ${host}; nothing will be written.`);

  const result = await runBackfill({ supabase: createSupabase(supabaseUrl, serviceRoleKey), mode, logger });
  return result.failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(`Backfill failed: ${describe(error)}`);
    process.exitCode = 1;
  });
}
