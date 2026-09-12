import { createClient } from '@supabase/supabase-js';

import { normalizeStoredProfileImage } from '../../src/lib/profile-image-normalization';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Resize profile images that predate server-side normalisation.
 *
 * The `profiles` bucket only ever capped total bytes, never dimensions, so it
 * holds avatars to 1.63 MB and covers to 1.77 MB. Mobile renders `avatar_url`
 * directly, so a creator card fetched the whole thing to fill a 48pt circle.
 * A profile saved from now on is normalised on the server; this applies the
 * same rule to what is already stored.
 *
 * Each object is rewritten in place, so no column changes and nothing is
 * orphaned. Objects already within their role's size are left alone.
 *
 * Dry run by default; `--execute --project-ref=<ref>` mutates.
 */

const PROFILE_BUCKET = 'profiles';

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const executionMode = parseBackfillExecutionMode({ supabaseUrl });
logBackfillExecutionMode(executionMode);

async function main() {
  // Only what a profile actually points at: an unreferenced upload costs
  // nobody a download, and rewriting it would spend bytes for no reader.
  const { data, error } = await supabase
    .from('profiles')
    .select('id, avatar_url, cover_url')
    .or('avatar_url.not.is.null,cover_url.not.is.null');
  if (error) throw new Error(`Unable to read profiles: ${error.message}`);

  const referenced = new Set<string>();
  for (const row of (data ?? []) as Array<{ avatar_url: string | null; cover_url: string | null }>) {
    for (const url of [row.avatar_url, row.cover_url]) {
      if (!url) continue;
      const marker = `/object/public/${PROFILE_BUCKET}/`;
      const index = url.indexOf(marker);
      if (index >= 0) referenced.add(decodeURIComponent(url.slice(index + marker.length)));
    }
  }

  console.log(`Examining ${referenced.size} referenced profile images.`);
  let resized = 0;
  let untouched = 0;

  for (const filePath of [...referenced].sort()) {
    const { data: object } = await supabase.storage.from(PROFILE_BUCKET).download(filePath);
    const bytes = object ? (await object.arrayBuffer()).byteLength : 0;

    if (!executionMode.execute) {
      console.log(`  would normalize ${filePath} (${bytes} B)`);
      untouched += 1;
      continue;
    }

    const rewritten = await normalizeStoredProfileImage({
      adminSupabase: supabase,
      bucket: PROFILE_BUCKET,
      filePath,
    });
    if (rewritten) {
      resized += 1;
      console.log(`  resized ${filePath} (was ${bytes} B)`);
    } else {
      untouched += 1;
      console.log(`  left ${filePath} alone (${bytes} B)`);
    }
  }

  console.log(`\nResized: ${resized}\nLeft alone: ${untouched}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
