import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '../src/lib/storage-ownership';
import {
  logBackfillExecutionMode,
  parseBackfillExecutionMode,
} from './backfill-execution-mode.mjs';

/**
 * Retire the public media of creation posts that are already private.
 *
 * Until the post route learned to move a creation's media between its public
 * derivative and the owner's private copy, a post made private through it
 * kept its derivative in the public bucket and its generation flagged public.
 * Nothing revisits those rows: the showcase hides the post, but the object
 * stays fetchable and the Creations card still says public. This applies the
 * private flip the post route performs today, once, to every creation post
 * that is private and still carries any of that footprint -- including the
 * post_media rows the 2026-06 gallery backfill copied from the derivative,
 * whose preview objects are public too.
 *
 * The owner keeps their media through the durable private copy the generation
 * already points at; a post whose generation has no such copy is reported and
 * left alone rather than having its only copy deleted.
 *
 * Dry run by default; `--execute --project-ref=<ref>` mutates.
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

type PrivatePostRow = {
  id: string;
  user_id: string;
  generation_id: string;
  showcase_asset_path: string | null;
  output_url: string | null;
};

type GenerationRow = {
  id: string;
  user_id: string;
  is_public: boolean | null;
  showcase_asset_path: string | null;
  output_url: string | null;
};

type MediaRow = {
  id: string;
  storage_path: string | null;
  preview_storage_path: string | null;
  rendition_storage_path: string | null;
  teaser_storage_path: string | null;
};

function canonicalShowcasePath(value: string | null | undefined, generationId: string): string | null {
  if (!value) return null;
  const canonical = parseCanonicalStorageObjectPath(value, { minimumSegments: 3 });
  return canonical?.startsWith(`showcase/${generationId}/`) ? canonical : null;
}

async function storedObjectExists(client: SupabaseClient, bucket: string, filePath: string): Promise<boolean> {
  const slash = filePath.lastIndexOf('/');
  const folder = slash >= 0 ? filePath.slice(0, slash) : '';
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const { data, error } = await client.storage.from(bucket).list(folder, { search: name, limit: 100 });
  if (error) throw error;
  return (data ?? []).some((entry) => entry.name === name);
}

/**
 * Everything under showcase/<generationId>/ is this generation's public
 * footprint — derivative, hashed previews, and the pre-hash `.preview.webp`
 * files of the first pipeline revision, which no column or row references.
 * Listing the folder catches those orphans; matching by column alone missed
 * them.
 */
async function listGenerationFolderObjects(
  client: SupabaseClient,
  generationId: string,
): Promise<string[]> {
  const folder = `showcase/${generationId}`;
  const { data, error } = await client.storage.from(SHOWCASE_BUCKET).list(folder, { limit: 1000 });
  if (error) throw error;
  return (data ?? [])
    .filter((entry) => entry.id !== null || entry.metadata !== null)
    .map((entry) => `${folder}/${entry.name}`)
    .flatMap((filePath) => {
      const canonical = canonicalShowcasePath(filePath, generationId);
      return canonical ? [canonical] : [];
    });
}

async function main() {
  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, user_id, generation_id, showcase_asset_path, output_url')
    .eq('visibility', 'private')
    .not('generation_id', 'is', null)
    .order('created_at', { ascending: true });
  if (postsError) throw postsError;

  let retired = 0;
  let skipped = 0;
  let clean = 0;

  for (const post of (posts ?? []) as PrivatePostRow[]) {
    const { data: generation, error: generationError } = await supabase
      .from('generations')
      .select('id, user_id, is_public, showcase_asset_path, output_url')
      .eq('id', post.generation_id)
      .maybeSingle();
    if (generationError) throw generationError;
    if (!generation || (generation as GenerationRow).user_id !== post.user_id) {
      console.warn(`[skip] ${post.id}: generation ${post.generation_id} missing or owned by someone else`);
      skipped += 1;
      continue;
    }
    const generationRow = generation as GenerationRow;

    const { data: mediaRows, error: mediaError } = await supabase
      .from('post_media')
      .select('id, storage_path, preview_storage_path, rendition_storage_path, teaser_storage_path')
      .eq('post_id', post.id);
    if (mediaError) throw mediaError;
    const legacyRows = ((mediaRows ?? []) as MediaRow[]).filter((row) => (
      Boolean(canonicalShowcasePath(row.storage_path, generationRow.id))
    ));

    const removablePaths = new Set<string>();
    for (const candidate of [post.showcase_asset_path, generationRow.showcase_asset_path]) {
      const canonical = canonicalShowcasePath(candidate, generationRow.id);
      if (canonical) removablePaths.add(canonical);
    }
    for (const row of legacyRows) {
      for (const candidate of [row.storage_path, row.preview_storage_path, row.rendition_storage_path, row.teaser_storage_path]) {
        const canonical = canonicalShowcasePath(candidate, generationRow.id);
        if (canonical) removablePaths.add(canonical);
      }
    }
    for (const orphanPath of await listGenerationFolderObjects(supabase, generationRow.id)) {
      removablePaths.add(orphanPath);
    }

    const stale =
      Boolean(generationRow.is_public)
      || Boolean(generationRow.showcase_asset_path)
      || Boolean(post.showcase_asset_path)
      || legacyRows.length > 0
      || removablePaths.size > 0;
    if (!stale) {
      clean += 1;
      continue;
    }

    // The owner's copy must be in place before the public one goes.
    const durableSource = generationRow.output_url ?? post.output_url;
    const durableLocation = durableSource
      ? getUserOwnedStoredMediaLocation(durableSource, post.user_id)
      : null;
    const durableExists = durableLocation
      ? await storedObjectExists(supabase, durableLocation.bucket, durableLocation.filePath)
      : false;
    if (!durableExists) {
      console.warn(`[skip] ${post.id}: no durable private copy at ${durableSource ?? '<none>'}; make the post private from the app to create one`);
      skipped += 1;
      continue;
    }

    const paths = [...removablePaths];
    console.log(
      `[${executionMode.dryRun ? 'would retire' : 'retire'}] post ${post.id} (generation ${generationRow.id}): `
      + `is_public=${String(generationRow.is_public)}, legacy media rows=${legacyRows.length}, objects=${paths.length}`,
    );
    for (const filePath of paths) console.log(`    - ${filePath}`);
    if (executionMode.dryRun) {
      retired += 1;
      continue;
    }

    // Same order as the post route: rows first, then the flags, then the objects.
    if (legacyRows.length > 0) {
      const { error } = await supabase.from('post_media').delete().in('id', legacyRows.map((row) => row.id));
      if (error) throw error;
    }
    const postPatch: Record<string, unknown> = { showcase_asset_path: null };
    if (durableSource && durableSource !== post.output_url) postPatch.output_url = durableSource;
    {
      const { error } = await supabase.from('posts').update(postPatch).eq('id', post.id).eq('user_id', post.user_id);
      if (error) throw error;
    }
    {
      const { error } = await supabase
        .from('generations')
        .update({ is_public: false, showcase_asset_path: null })
        .eq('id', generationRow.id)
        .eq('user_id', post.user_id);
      if (error) throw error;
    }
    if (paths.length > 0) {
      const { error } = await supabase.storage.from(SHOWCASE_BUCKET).remove(paths);
      if (error) throw error;
    }
    retired += 1;
  }

  console.log(
    `${executionMode.dryRun ? 'Dry run complete' : 'Backfill complete'}: `
    + `${retired} ${executionMode.dryRun ? 'would be retired' : 'retired'}, ${clean} already clean, ${skipped} skipped.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
