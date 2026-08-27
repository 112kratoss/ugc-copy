import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { toUsablePreviewSize, type PreviewSize } from '../src/lib/preview-dimensions';
import { getStorageLocation } from '../src/lib/storage-path';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Fill `generations.preview_width` / `preview_height` for rows whose preview
 * already exists.
 *
 * Why this matters is on the 20260827090000 migration: the mobile showcase is a
 * masonry grid, and a card with no aspect ratio is laid out at a placeholder
 * height and then resized once the client has measured the image — under the
 * reader, which is what Apple's Collections guidance tells you not to do. Every
 * `post_media` row already carries dimensions; the gap is the public posts that
 * predate that table and borrow their linked generation's preview instead.
 *
 * Measures the STORED PREVIEW, not the source output. A preview is a
 * `fit: inside` resize, so its ratio is the source's while its bytes are a few
 * tens of kilobytes — and storage egress is this backend's scaling wall, so
 * re-downloading full-resolution originals to learn a ratio would be the wrong
 * trade twice over.
 *
 * Dry run by default; mutating needs `--execute --project-ref=<ref>`.
 */

const BATCH_SIZE = 200;

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const executionMode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(executionMode);

type PendingRow = {
  id: string;
  preview_url: string | null;
};

async function loadPendingRows(): Promise<PendingRow[]> {
  const rows: PendingRow[] = [];

  for (let offset = 0; ; offset += BATCH_SIZE) {
    const { data, error } = await supabase
      .from('generations')
      .select('id, preview_url')
      .not('preview_url', 'is', null)
      .is('preview_width', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as PendingRow[];
    rows.push(...page);
    if (page.length < BATCH_SIZE) return rows;
  }
}

async function measureStoredPreview(previewUrl: string) {
  const location = getStorageLocation(previewUrl);
  if (!location) return null;

  const download = await supabase.storage.from(location.bucket).download(location.filePath);
  if (download.error || !download.data) return null;

  const metadata = await sharp(Buffer.from(await download.data.arrayBuffer())).metadata();
  return toUsablePreviewSize(metadata.width, metadata.height);
}

async function main() {
  const rows = await loadPendingRows();
  console.log(`generations with a preview and no recorded size: ${rows.length}`);

  let measured = 0;
  let unreadable = 0;
  let written = 0;

  for (const row of rows) {
    if (!row.preview_url) continue;

    let size: PreviewSize | null = null;
    try {
      size = await measureStoredPreview(row.preview_url);
    } catch (error) {
      console.warn(`  ${row.id}: preview could not be measured — ${describe(error)}`);
    }

    if (!size) {
      unreadable += 1;
      continue;
    }

    measured += 1;
    console.log(`  ${row.id}: ${size.width}x${size.height}`);

    if (executionMode.dryRun) continue;

    const { error } = await supabase
      .from('generations')
      .update({ preview_width: size.width, preview_height: size.height })
      .eq('id', row.id)
      // Never overwrite a size already recorded: a concurrent preview repair
      // measured the bytes it just wrote, which is fresher than this pass.
      .is('preview_width', null);

    if (error) {
      console.warn(`  ${row.id}: update failed — ${error.message}`);
      continue;
    }
    written += 1;
  }

  console.log(
    executionMode.dryRun
      ? `\nDry run: ${measured} measurable, ${unreadable} skipped. Re-run with --execute --project-ref=<ref> to write.`
      : `\nWrote ${written} of ${measured} measurable rows; ${unreadable} skipped.`
  );
}

/**
 * Supabase errors are plain objects, not `Error`s, so `String(error)` on one
 * prints `[object Object]` — which is what the first run of this script said
 * when production had not yet taken the migration. Read the shape.
 */
function describe(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { message, code, hint } = error as { message?: unknown; code?: unknown; hint?: unknown };
    const parts = [
      typeof message === 'string' ? message : null,
      typeof code === 'string' ? `(${code})` : null,
      typeof hint === 'string' ? hint : null,
    ].filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return String(error);
}

void main().catch((error) => {
  console.error(describe(error));
  process.exitCode = 1;
});
