import { createClient } from '@supabase/supabase-js';

import { regenerateVideoPosters } from '../../src/lib/media-preview-repair';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Re-extract every existing video poster at the clip's first frame.
 *
 *   npm run regenerate:video-posters -- --dry-run   # list the rows, write nothing
 *   npm run regenerate:video-posters                 # regenerate and move each row to its new poster
 *
 * One-off for the poster moving from one second into the clip to its first
 * frame (src/lib/video-poster.ts). Rows stay `ready` throughout; each new
 * poster lands at a new content-hashed path, so clients see it as a new image.
 */
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const executionMode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(executionMode);

async function main() {
  const summary = await regenerateVideoPosters(supabase, {
    dryRun: executionMode.dryRun,
    log: (line) => console.log(line),
  });
  console.log(executionMode.dryRun ? 'Dry run, nothing written:' : 'Video poster regeneration complete:', summary);
  if (summary.generations.failed + summary.posts.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
