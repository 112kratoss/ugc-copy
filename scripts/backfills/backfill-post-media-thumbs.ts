import { createClient } from '@supabase/supabase-js';

import {
  canStorePostMediaThumb,
  encodePostMediaThumb,
  POST_MEDIA_THUMB_FOLDER_PATTERN,
  storePostMediaThumb,
} from '../../src/lib/post-media-preview';
import { queueUnrecordedShowcaseMedia } from '../../src/lib/unrecorded-showcase-media';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Build the row thumb (`post_media.thumb_storage_path`, migration
 * `20261123152813_post_media_search_thumbs.sql`) for media whose preview
 * predates it.
 *
 * Search rows draw a cover in a 28 to 48 px frame and used to load its 720 px
 * preview for it. The preview sweep now stores a 144 px thumb beside every
 * preview it makes in a creation's public folder; this fills in the covers
 * made before, of posts search can show. Search draws the preview for a row
 * with no thumb, so until this runs nothing is wrong, only heavier.
 *
 * Each thumb is encoded from the stored preview (a ~30 KB read), never from
 * the source, exactly as the sweep encodes it, and lands beside it in the
 * creation's public folder. The pointer is written only if the row still
 * names the preview the thumb was made from and no thumb yet; otherwise (a
 * sweep or a labelling moved it on) the object goes to the revocation queue,
 * as does any upload a failure leaves unnamed. The database refuses a thumb
 * outside a creation's folder or beside a private preview
 * (`post_media_thumb_beside_public_preview_check`).
 *
 * Dry run by default: it counts every candidate, reads the previews of one
 * pass and encodes their thumbs in memory, so it reports exact bytes for that
 * pass and an estimate for the rest, and writes nothing.
 * `--execute --project-ref=<ref>` writes. `--limit=<n>` bounds one pass
 * (default 200, at most 2,000); `--after=<post_media id>` resumes after the
 * last id a pass printed.
 */

const PUBLIC_BUCKET = 'showcase_media';
const PAGE_SIZE = 100;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const executionMode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(executionMode);

function readArgument(name: string): string | null {
  const inline = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3).trim() || null : null;
}

function readLimit(): number {
  const parsed = Number.parseInt(readArgument('limit') ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;
}

function readAfter(): string | null {
  const after = readArgument('after');
  if (after && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)) {
    throw new Error('--after takes a post_media id.');
  }
  return after;
}

type CandidateRow = {
  id: string;
  storage_path: string | null;
  preview_storage_path: string;
};

// A candidate is a ready preview with no thumb, in a creation's public folder
// (the only place a thumb may be: `canStorePostMediaThumb`, matched here by the
// same pattern, so a row that can never get one is never read), of a post search
// can show: public, visible, not archived, not labelled (search_post_picture's
// rules) and not deleted-but-kept for its buyers (tombstoned). Private,
// hidden, archived and taken-down posts get none, and a taken-down row naming
// removed files is never read. Both reads below hold the same filters.

async function countCandidates(after: string | null): Promise<number> {
  let query = supabase
    .from('post_media')
    .select('id, posts!inner(id)', { count: 'exact', head: true })
    .eq('preview_status', 'ready')
    .filter('preview_storage_path', 'match', POST_MEDIA_THUMB_FOLDER_PATTERN)
    .is('thumb_storage_path', null)
    .eq('posts.visibility', 'public')
    .eq('posts.review_status', 'visible')
    .is('posts.archived_at', null)
    .eq('posts.is_nsfw', false)
    .is('posts.tombstoned_at', null);
  if (after) query = query.gt('id', after);
  const { count, error } = await query;
  if (error) throw new Error(`Unable to count post media: ${error.message}`);
  return count ?? 0;
}

async function readPage(after: string | null, size: number): Promise<CandidateRow[]> {
  let query = supabase
    .from('post_media')
    .select('id, storage_path, preview_storage_path, posts!inner(id)')
    .eq('preview_status', 'ready')
    .filter('preview_storage_path', 'match', POST_MEDIA_THUMB_FOLDER_PATTERN)
    .is('thumb_storage_path', null)
    .eq('posts.visibility', 'public')
    .eq('posts.review_status', 'visible')
    .is('posts.archived_at', null)
    .eq('posts.is_nsfw', false)
    .is('posts.tombstoned_at', null);
  if (after) query = query.gt('id', after);
  const { data, error } = await query.order('id', { ascending: true }).limit(size);
  if (error) throw new Error(`Unable to read post media: ${error.message}`);
  return (data ?? []) as unknown as CandidateRow[];
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const limit = readLimit();
  let after = readAfter();
  const total = await countCandidates(after);
  console.log(`${total} cover(s) in a creation's public folder with no thumb, of posts search can show${after ? `, after ${after}` : ''}; this pass takes up to ${limit}.`);

  let examined = 0;
  let built = 0;
  let movedOn = 0;
  let skipped = 0;
  let failed = 0;
  let previewBytesRead = 0;
  let thumbBytes = 0;

  while (examined < limit) {
    const requested = Math.min(PAGE_SIZE, limit - examined);
    const page = await readPage(after, requested);
    if (page.length === 0) break;
    for (const row of page) {
      examined += 1;
      after = row.id;
      // The thumb is named from the source as the sweep names it, beside it,
      // and only in a creation's public folder: a row whose source lies
      // elsewhere is left alone before anything is read.
      const naming = row.storage_path ?? row.preview_storage_path;
      if (!canStorePostMediaThumb(naming)) {
        skipped += 1;
        console.log(`  skip ${row.id}: its media is not in a creation's public folder`);
        continue;
      }
      // Named only by the update below; anything else goes to the revocation queue.
      const uploaded: string[] = [];
      try {
        const download = await supabase.storage.from(PUBLIC_BUCKET).download(row.preview_storage_path);
        if (download.error || !download.data) {
          throw download.error ?? new Error('preview could not be downloaded');
        }
        const preview = Buffer.from(await download.data.arrayBuffer());
        previewBytesRead += preview.byteLength;

        if (!executionMode.execute) {
          const thumb = await encodePostMediaThumb(preview);
          thumbBytes += thumb.byteLength;
          built += 1;
          console.log(`  would write a thumb for ${row.id} (${preview.byteLength} B -> ${thumb.byteLength} B)`);
          continue;
        }

        const thumb = await storePostMediaThumb({
          supabase,
          storagePath: naming,
          preview,
          onUploaded: (path) => { uploaded.push(path); },
        });
        if (!thumb) throw new Error('no thumb may be made for this source');

        // The object first, the pointer second, and only beside the preview it
        // was made from.
        const { data: updated, error: updateError } = await supabase
          .from('post_media')
          .update({ thumb_storage_path: thumb.path })
          .eq('id', row.id)
          .eq('preview_storage_path', row.preview_storage_path)
          .is('thumb_storage_path', null)
          .select('id');
        if (updateError) throw updateError;
        if (!updated?.length) {
          movedOn += 1;
          await queueUnrecordedShowcaseMedia(supabase, uploaded);
          console.log(`  moved on ${row.id}: its preview or thumb changed meanwhile`);
          continue;
        }

        thumbBytes += thumb.bytes;
        built += 1;
        console.log(`  wrote ${thumb.path} (${preview.byteLength} B -> ${thumb.bytes} B)`);
      } catch (error) {
        await queueUnrecordedShowcaseMedia(supabase, uploaded);
        failed += 1;
        console.error(`  FAILED ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (page.length < requested) break;
  }

  const meanPreview = built > 0 ? previewBytesRead / built : 0;
  const meanThumb = built > 0 ? thumbBytes / built : 0;
  const remaining = Math.max(0, total - examined);
  console.log([
    '',
    `Mode: ${executionMode.execute ? 'execute' : 'dry run (nothing written)'}`,
    `Candidates: ${total}`,
    `Examined this pass: ${examined}`,
    `${executionMode.execute ? 'Built' : 'Would build'}: ${built}`,
    `Moved on meanwhile: ${movedOn}`,
    `Skipped (media outside a creation's public folder): ${skipped}`,
    `Failed: ${failed}`,
    `Preview bytes read: ${previewBytesRead} (${kilobytes(previewBytesRead)})`,
    `Thumb bytes ${executionMode.execute ? 'written' : 'that would be written'}: ${thumbBytes} (${kilobytes(thumbBytes)})`,
    built > 0 ? `Per picture: preview ${kilobytes(meanPreview)} -> thumb ${kilobytes(meanThumb)} (${(100 * (1 - meanThumb / meanPreview)).toFixed(1)}% smaller)` : '',
    built > 0 && remaining > 0
      ? `Estimate for the ${remaining} not examined: read ${kilobytes(remaining * meanPreview)}, write ${kilobytes(remaining * meanThumb)}`
      : '',
    examined > 0 && remaining > 0 ? `Resume with --after=${after}` : '',
  ].filter(Boolean).join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
