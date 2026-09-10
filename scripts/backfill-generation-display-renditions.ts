import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import {
  buildDisplayRenditionPath,
  encodeDisplayRendition,
} from '../src/lib/media-display-rendition';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '../src/lib/showcase-media-cache';
import { getStorageLocation } from '../src/lib/storage-path';
import { toStorageUploadBody } from '../src/lib/storage-upload-body';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Build the display rendition for private creations that predate it.
 *
 * `npm run backfill:media-display-renditions` did this for published post
 * media. Private creations are the other half of F3 and the larger one: a
 * creator opens their own library far more than a stranger opens the feed,
 * and every open downloaded the original. The image path now writes the
 * display rendition at settlement and the repair sweep records it when it
 * rebuilds a preview; this fills in everything made before that shipped, and
 * closes the gap for any row whose post-settlement stamp was lost.
 *
 * Same reasons as its sibling for being a script: bounded, resumable work that
 * downloads and re-encodes every image source has no business in a migration,
 * and it cannot ride the repair sweep, which is keyed on `preview_status`.
 *
 * Sources live in the private `generated_images` bucket and the rendition goes
 * beside them, so the download is service-role and the object is signed for
 * the owner like the preview. A row whose source earns no display (already
 * display-sized, or WebP cannot shrink it by a quarter) is left null and
 * counted as `skipped`; every reader falls back to the source for it.
 *
 * Dry run by default; `--execute --project-ref=<ref>` mutates.
 * `--limit=<n>` bounds one pass so the work can be spread out.
 */

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
  output_url: string | null;
};

async function main() {
  const limit = readLimit();
  const { data, error } = await supabase
    .from('generations')
    .select('id, output_url')
    .eq('status', 'succeeded')
    .eq('category', 'image')
    .is('display_url', null)
    .is('archived_at', null)
    .is('source_unavailable_at', null)
    .like('output_url', 'generated_images/%')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Unable to read generations: ${error.message}`);
  const rows = (data ?? []) as CandidateRow[];
  console.log(`Examining ${rows.length} image creations without a display rendition.`);

  let built = 0;
  let skipped = 0;
  let failed = 0;
  let sourceBytesRead = 0;
  let displayBytesWritten = 0;

  for (const row of rows) {
    const outputUrl = row.output_url;
    const location = outputUrl ? getStorageLocation(outputUrl) : null;
    if (!outputUrl || !location) continue;

    try {
      const download = await supabase.storage.from(location.bucket).download(location.filePath);
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

      const displayPath = buildDisplayRenditionPath(outputUrl, display.storagePathHash);
      const displayLocation = getStorageLocation(displayPath);
      if (!displayLocation) throw new Error(`display path has no bucket: ${displayPath}`);
      displayBytesWritten += display.body.byteLength;

      if (!executionMode.execute) {
        built += 1;
        console.log(`  would write ${displayPath} (${input.byteLength} B -> ${display.body.byteLength} B)`);
        continue;
      }

      const upload = await supabase.storage
        .from(displayLocation.bucket)
        .upload(displayLocation.filePath, toStorageUploadBody(display.body, 'image/webp'), {
          cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
          contentType: 'image/webp',
          upsert: true,
        });
      if (upload.error) throw upload.error;

      // The object first, the pointer second; and only while the row still
      // serves the file this was encoded from.
      const { error: updateError } = await supabase
        .from('generations')
        .update({ display_url: displayPath })
        .eq('id', row.id)
        .eq('output_url', outputUrl);
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
