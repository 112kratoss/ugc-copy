import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import {
  buildDisplayRenditionPath,
  encodeDisplayRendition,
} from '../../src/lib/media-display-rendition';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '../../src/lib/showcase-media-cache';
import { toStorageUploadBody } from '../../src/lib/storage-upload-body';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Build the display rendition for post media that predates it.
 *
 * The 720px preview is a grid size; a full-screen viewer reached past it and
 * loaded the source, which made images 48% of a day's Storage bytes — more
 * than every video kind together. The preview writer now emits a 1440px WebP
 * alongside the preview from the same decode, but only for media written after
 * it shipped. This fills in the rest.
 *
 * It is a script rather than a migration because building one means
 * downloading and re-encoding every image source: bounded, resumable work that
 * has no business blocking a release. It is also not folded into the repair
 * sweep, because the sweep is keyed on `preview_status` and moving a row off
 * `ready` to trigger it would report `gridReady: false` and drop the post from
 * the mobile showcase grid while the backfill ran.
 *
 * Rows whose source earns no display rendition (already display-sized, or one
 * WebP cannot meaningfully shrink) are left null and counted as `skipped`;
 * every reader falls back to the source for those, exactly as before.
 *
 * Dry run by default; `--execute --project-ref=<ref>` mutates.
 * `--limit=<n>` bounds one pass so the work can be spread out.
 */

const SHOWCASE_BUCKET = 'showcase_media';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const executionMode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(executionMode);

function readLimit(): number {
  const inline = process.argv.slice(2).find((argument) => argument.startsWith('--limit='));
  const parsed = inline ? Number.parseInt(inline.slice('--limit='.length), 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 200;
}

type CandidateRow = {
  id: string;
  storage_path: string | null;
  content_type: string | null;
};

async function main() {
  const limit = readLimit();
  const { data, error } = await supabase
    .from('post_media')
    .select('id, storage_path, content_type')
    .eq('media_kind', 'image')
    .not('storage_path', 'is', null)
    .is('display_storage_path', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Unable to read post media: ${error.message}`);
  const rows = (data ?? []) as CandidateRow[];
  console.log(`Examining ${rows.length} image rows without a display rendition.`);

  let built = 0;
  let skipped = 0;
  let failed = 0;
  let sourceBytesRead = 0;
  let displayBytesWritten = 0;

  for (const row of rows) {
    const storagePath = row.storage_path;
    if (!storagePath) continue;

    try {
      const download = await supabase.storage.from(SHOWCASE_BUCKET).download(storagePath);
      if (download.error || !download.data) {
        throw download.error ?? new Error('source could not be downloaded');
      }
      const input = Buffer.from(await download.data.arrayBuffer());
      sourceBytesRead += input.byteLength;

      const image = sharp(input).rotate();
      const metadata = await image.metadata();
      const display = await encodeDisplayRendition({
        image,
        sourceBytes: input.byteLength,
        width: metadata.width,
        height: metadata.height,
      });

      if (!display) {
        skipped += 1;
        console.log(`  skip ${row.id}: source is already display-sized (${input.byteLength} B)`);
        continue;
      }

      const displayPath = buildDisplayRenditionPath(storagePath, display.storagePathHash);
      displayBytesWritten += display.body.byteLength;

      if (!executionMode.execute) {
        built += 1;
        console.log(`  would write ${displayPath} (${input.byteLength} B -> ${display.body.byteLength} B)`);
        continue;
      }

      const upload = await supabase.storage
        .from(SHOWCASE_BUCKET)
        .upload(displayPath, toStorageUploadBody(display.body, 'image/webp'), {
          cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
          contentType: 'image/webp',
          upsert: true,
        });
      if (upload.error) throw upload.error;

      // The object first, the pointer second: a path recorded before its bytes
      // exist would send every viewer to a 404.
      const { error: updateError } = await supabase
        .from('post_media')
        .update({ display_storage_path: displayPath })
        .eq('id', row.id);
      if (updateError) throw updateError;

      built += 1;
      console.log(`  wrote ${displayPath} (${input.byteLength} B -> ${display.body.byteLength} B)`);
    } catch (error) {
      failed += 1;
      console.error(`  FAILED ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log([
    '',
    `Built: ${built}`,
    `Skipped (no saving worth storing): ${skipped}`,
    `Failed: ${failed}`,
    `Source bytes read: ${sourceBytesRead}`,
    `Display bytes written: ${displayBytesWritten}`,
    built > 0 && sourceBytesRead > 0
      ? `Per-open saving on the rows built: ${(100 * (1 - displayBytesWritten / sourceBytesRead)).toFixed(2)}%`
      : '',
  ].filter(Boolean).join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
