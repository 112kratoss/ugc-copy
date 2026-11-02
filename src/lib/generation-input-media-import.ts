import type { SupabaseClient } from '@supabase/supabase-js';

import { isGuestUser, isOwnOrLinkedAccountId } from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import { SHOWCASE_MEDIA_BUCKET } from '@/lib/generation-post-media';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { loadGenerationRecipeRemixInputMediaByPostId } from '@/lib/post-resource-bundles-server';
import { resolveRemixAccess, type RemixAccessGeneration } from '@/lib/remix-access';
import { createServiceClient } from '@/lib/server-helpers';
import { getCanonicalStoredMediaLocation, parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

const GENERATION_INPUTS_BUCKET = 'generation_inputs';
const REMIX_IMPORT_FOLDER = 'remix-imports';
const SIGNED_URL_TTL_SECONDS = 3600;
const MAX_POSTS_PER_GENERATION = 5;

/** Where a creation's result can live: its post's public copy, or the creator's private output. */
const REMIX_RESULT_BUCKETS = [SHOWCASE_MEDIA_BUCKET, 'generated_images', 'generated_videos'];
const REMIX_RESULT_GENERATION_SELECT =
  'id, user_id, is_public, share_input_media_for_remix, template_run_id, template_run_step_id, showcase_asset_path, output_url';

type RemixResultGeneration = RemixAccessGeneration & {
  showcase_asset_path: string | null;
  output_url: string | null;
};

export type SharedInputMediaImportResult =
  /** Not a shared generation input the viewer may use — the caller's ownership error stands. */
  | { outcome: 'not-eligible' }
  /**
   * Retryable: a read, the copy or its signing failed (a retry reuses a copy
   * already made). A check that fails closed answers `not-eligible` instead: a
   * block check that fails counts as blocked, and the recipe loader reads a
   * failure as no entitlement.
   */
  | { outcome: 'failed' }
  | { outcome: 'imported'; storagePath: string; signedUrl: string };

export interface SharedInputMediaImportDependencies {
  createServiceClient?: typeof createServiceClient;
  isUserRelationshipBlocked?: typeof isUserRelationshipBlocked;
  loadGenerationRecipeRemixInputMediaByPostId?: typeof loadGenerationRecipeRemixInputMediaByPostId;
}

function isAlreadyExistsStorageError(error: { statusCode?: string | number; message?: string; error?: string }): boolean {
  return String(error.statusCode ?? '') === '409'
    || error.error === 'Duplicate'
    || /already exists/i.test(error.message ?? '');
}

/**
 * The account a creation is posted under: its owner, or for one made as a
 * guest, the account the guest was linked to (`showcase-publish-service.ts`).
 * That is who a viewer sees on the post, and so who they block or are blocked
 * by. Throws when the owner's profile cannot be read.
 */
async function loadCreatorAccountId(adminSupabase: SupabaseClient, ownerUserId: string): Promise<string> {
  const { data, error } = await adminSupabase
    .from('profiles')
    .select('merged_into_user_id')
    .eq('id', ownerUserId)
    .maybeSingle();
  if (error) throw error;
  return (data as { merged_into_user_id: string | null } | null)?.merged_into_user_id || ownerUserId;
}

/**
 * Copies a shared generation input into the caller's own storage prefix.
 *
 * A remix (or an unlocked recipe) deliberately hands the viewer the original
 * creator's reference media, but every generation start requires references to
 * live under the caller's own `<userId>/…` prefix — the path prefix *is* the
 * ownership model. This bridges the two: when the submitted reference resolves
 * to another user's durable input object, re-derive the sharing decision
 * server-side (never from the client's signed URL) and, if the viewer is
 * entitled to remix it, copy the object into
 * `generation_inputs/<viewer>/remix-imports/<sourceGenerationId>/<file>`.
 * The deterministic destination makes retries and repeated remixes reuse one
 * copy, and the remix keeps working even if the creator later deletes the
 * original or stops sharing.
 *
 * Recreate on the viewer's own pre-registration work lands here too: that work
 * keeps the guest UUID it was made under, so its references fail the prefix
 * check. A guest identity linked to the viewer needs no sharing decision, only
 * the same copy.
 *
 * Only durable inputs (rows in `generation_input_media`) are importable;
 * legacy pre-durable references stay rejected until the repair backfill
 * reaches them.
 */
export async function importSharedGenerationInputMedia(params: {
  /** The reference exactly as submitted — a storage path or storage-object URL. */
  source: string;
  viewerUserId: string;
  dependencies?: SharedInputMediaImportDependencies;
}): Promise<SharedInputMediaImportResult> {
  const location = getCanonicalStoredMediaLocation(params.source, {
    allowedBuckets: [GENERATION_INPUTS_BUCKET],
  });
  if (!location) return { outcome: 'not-eligible' };

  const ownerUserId = location.filePath.split('/')[0];
  if (!ownerUserId || ownerUserId === params.viewerUserId) return { outcome: 'not-eligible' };

  const adminSupabase = (params.dependencies?.createServiceClient ?? createServiceClient)();
  const storagePathKey = `${location.bucket}/${location.filePath}`;

  const mediaRowResult = await adminSupabase
    .from('generation_input_media')
    .select('id, generation_id, user_id, storage_path')
    .eq('storage_path', storagePathKey)
    .limit(1);
  if (mediaRowResult.error) {
    logBackendError('failed_to_load_shared_input_media_row_for_import', { error: mediaRowResult.error });
    return { outcome: 'failed' };
  }
  const mediaRow = (mediaRowResult.data ?? [])[0] as
    | { id: string; generation_id: string; user_id: string; storage_path: string }
    | undefined;
  if (!mediaRow || mediaRow.user_id !== ownerUserId) return { outcome: 'not-eligible' };

  const generationResult = await adminSupabase
    .from('generations')
    .select('id, user_id, is_public, share_input_media_for_remix, template_run_id, template_run_step_id')
    .eq('id', mediaRow.generation_id)
    .maybeSingle();
  if (generationResult.error) {
    logBackendError('failed_to_load_generation_for_shared_input_import', { error: generationResult.error });
    return { outcome: 'failed' };
  }
  const generation = generationResult.data as RemixAccessGeneration | null;
  if (!generation || generation.user_id !== ownerUserId) return { outcome: 'not-eligible' };

  // Creations made before the viewer registered keep their guest UUID, so
  // Recreate submits their references under that guest's prefix. They are
  // still the viewer's own inputs, and the block gate and sharing checks below
  // exist for other people's media. A failed link lookup reads as "not linked",
  // which keeps those checks in force.
  const ownedByViewer = await isOwnOrLinkedAccountId(adminSupabase, params.viewerUserId, ownerUserId);
  if (!ownedByViewer) {
    // Mirrors the remix gate's block check, which asks about the post's owner
    // (for a guest's creation, the account, not the guest id in the path): a
    // check that errors open is not a gate.
    let blocked = true;
    try {
      blocked = await (params.dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked)({
        adminSupabase,
        firstUserId: params.viewerUserId,
        secondUserId: await loadCreatorAccountId(adminSupabase, ownerUserId),
      });
    } catch (error) {
      logBackendError('failed_to_verify_block_state_before_shared_input_import', { error });
    }
    if (blocked) return { outcome: 'not-eligible' };

    // Free sharing first, decided as the remix routes decide it, because the
    // generation's flags are not the whole answer. Remixing someone else's
    // creation takes an account (/api/remix-source refuses a guest and
    // /api/showcase/remix admits none), while a generation start admits
    // guests. Then `resolveRemixAccess`: the post must show the creation now,
    // no recipe on it may be locked to this viewer, and it must not be a
    // template's result. Ownership and the block were settled above, so the
    // gate is given those answers rather than reading them again. A read that
    // fails here fails the import instead of allowing it. Then the paid recipe
    // entitlement via a post that links this generation — that loader
    // re-checks purchase, allowRemix, and eligibility.
    let authorized = false;
    if (generation.is_public === true && generation.share_input_media_for_remix === true) {
      try {
        const viewer = await adminSupabase.auth.admin.getUserById(params.viewerUserId);
        if (viewer.error) throw viewer.error;
        if (!viewer.data.user || isGuestUser(viewer.data.user)) return { outcome: 'not-eligible' };

        const access = await resolveRemixAccess({
          adminSupabase,
          viewerUserId: params.viewerUserId,
          generation,
          dependencies: {
            isOwnOrLinkedAccountId: async () => false,
            isUserRelationshipBlocked: async () => false,
          },
        });
        authorized = access.allowed && access.includeSharedInputMedia;
      } catch (error) {
        logBackendError('failed_to_resolve_remix_access_for_shared_input_import', { error });
        return { outcome: 'failed' };
      }
    }
    if (!authorized) {
      const postsResult = await adminSupabase
        .from('posts')
        .select('id')
        .eq('generation_id', generation.id)
        .limit(MAX_POSTS_PER_GENERATION);
      if (postsResult.error) {
        logBackendError('failed_to_load_posts_for_shared_input_import', { error: postsResult.error });
        return { outcome: 'failed' };
      }
      const loadRecipeInputMedia = params.dependencies?.loadGenerationRecipeRemixInputMediaByPostId
        ?? loadGenerationRecipeRemixInputMediaByPostId;
      for (const post of (postsResult.data ?? []) as Array<{ id: string }>) {
        const items = await loadRecipeInputMedia({
          postId: post.id,
          generationId: generation.id,
          viewerUserId: params.viewerUserId,
          adminSupabase,
        });
        if (items.some((item) => item.storagePath === storagePathKey)) {
          authorized = true;
          break;
        }
      }
    }
    if (!authorized) return { outcome: 'not-eligible' };
  }

  const fileName = location.filePath.split('/').pop() ?? 'input';
  const destinationFilePath = `${params.viewerUserId}/${REMIX_IMPORT_FOLDER}/${mediaRow.generation_id}/${fileName}`;

  const copyResult = await adminSupabase.storage
    .from(location.bucket)
    .copy(location.filePath, destinationFilePath);
  if (copyResult.error && !isAlreadyExistsStorageError(copyResult.error)) {
    logBackendError('failed_to_copy_shared_input_media_for_import', { error: copyResult.error });
    return { outcome: 'failed' };
  }

  const signedResult = await adminSupabase.storage
    .from(location.bucket)
    .createSignedUrl(destinationFilePath, SIGNED_URL_TTL_SECONDS);
  if (signedResult.error || !signedResult.data?.signedUrl) {
    logBackendError('failed_to_sign_imported_shared_input_media', { error: signedResult.error });
    return { outcome: 'failed' };
  }

  return {
    outcome: 'imported',
    storagePath: `${location.bucket}/${destinationFilePath}`,
    signedUrl: signedResult.data.signedUrl,
  };
}

export type RemixResultMediaResult =
  /** Not the result of a creation the viewer may remix: the caller's ownership error stands. */
  | { outcome: 'not-eligible' }
  /** Retryable: a read or the signing failed. A check that fails closed answers `not-eligible`. */
  | { outcome: 'failed' }
  /** A link the start can read, built from the checked location: never the client's link. */
  | { outcome: 'resolved'; url: string };

/** Postgres's answer to a uuid column compared with text that is no uuid (`invalid_text_representation`). */
const INVALID_UUID_CODE = '22P02';

/**
 * The creation whose result `location` is, as the remix source hands a result
 * out (`resolveGenerationResultUrl` in `remix-source-server.ts`): the post's
 * showcase copy where the creation has one, otherwise the creator's private
 * output. Any other file names none: another file of the showcase folder, or
 * the private output of a creation whose post shows a copy. A path segment that
 * is no uuid names none either, rather than failing the read. Throws when the
 * read fails.
 */
async function loadRemixResultGeneration(
  adminSupabase: SupabaseClient,
  location: { bucket: string; filePath: string },
): Promise<RemixResultGeneration | null> {
  // A path segment that is no uuid names no creation; any other failed read throws.
  const namesNoCreation = (error: { code?: string }) => {
    if (error.code === INVALID_UUID_CODE) return true;
    throw error;
  };
  if (location.bucket === SHOWCASE_MEDIA_BUCKET) {
    const [namespace, generationId] = location.filePath.split('/');
    if (namespace !== 'showcase' || !generationId) return null;
    const { data, error } = await adminSupabase
      .from('generations')
      .select(REMIX_RESULT_GENERATION_SELECT)
      .eq('id', generationId)
      .maybeSingle();
    if (error && namesNoCreation(error)) return null;
    const generation = data as RemixResultGeneration | null;
    const showcaseAsset = generation?.showcase_asset_path
      ? parseCanonicalStorageObjectPath(generation.showcase_asset_path, { minimumSegments: 3 })
      : null;
    return showcaseAsset === location.filePath ? generation : null;
  }

  // Outputs are stored as `<bucket>/<owner>/<file>` (durable-generation-media.ts);
  // a legacy output kept as a link matches nothing and stays refused.
  const { data, error } = await adminSupabase
    .from('generations')
    .select(REMIX_RESULT_GENERATION_SELECT)
    .eq('user_id', location.filePath.split('/')[0])
    .eq('output_url', `${location.bucket}/${location.filePath}`)
    .limit(1);
  if (error && namesNoCreation(error)) return null;
  const generation = ((data ?? []) as RemixResultGeneration[])[0] ?? null;
  return generation && !generation.showcase_asset_path ? generation : null;
}

/**
 * A remix's original result, handed to a generation start as a reference ("Use
 * as reference" in the image, video and motion creators, on the web and in the
 * app).
 *
 * The remix source gives a remixer the original's result to show and to offer
 * as a reference, and neither form of it is under the caller's `<userId>/…`
 * prefix, so every generation start refused it as someone else's media. When
 * the submitted file is exactly the result the remix source hands out, and the
 * viewer may remix the creation right now (`resolveRemixAccess`, the gate the
 * remix source applies: an account for anyone else's creation, the post
 * showing it, no block, no recipe locked to them, not a template's result),
 * answer a link to it built here from the checked location: the showcase
 * copy's public link, or a signed link to the private output, which the remix
 * source hands this viewer too. Nothing is copied: the run keeps its own copy
 * of what it reads (`persistGenerationInputMedia`, which reads the project's
 * storage host as an allowlisted one), so a copy here would only leave a
 * second file per remixer that nothing reclaims. A result needs no sharing
 * switch, unlike an input: its post shows it to everyone who may remix it.
 */
export async function resolveRemixResultMedia(params: {
  /** The reference exactly as submitted — a storage path or storage-object URL. */
  source: string;
  viewerUserId: string;
  dependencies?: SharedInputMediaImportDependencies;
}): Promise<RemixResultMediaResult> {
  const location = getCanonicalStoredMediaLocation(params.source, {
    allowedBuckets: REMIX_RESULT_BUCKETS,
  });
  if (!location) return { outcome: 'not-eligible' };
  // The caller's own output resolved before this was asked.
  if (location.bucket !== SHOWCASE_MEDIA_BUCKET && location.filePath.split('/')[0] === params.viewerUserId) {
    return { outcome: 'not-eligible' };
  }

  const adminSupabase = (params.dependencies?.createServiceClient ?? createServiceClient)();

  let generation: RemixResultGeneration | null;
  try {
    generation = await loadRemixResultGeneration(adminSupabase, location);
  } catch (error) {
    logBackendError('failed_to_load_generation_for_remix_result', { error });
    return { outcome: 'failed' };
  }
  if (!generation?.user_id) return { outcome: 'not-eligible' };

  // A failed link lookup reads as "not linked", which keeps every check below in force.
  const ownedByViewer = await isOwnOrLinkedAccountId(adminSupabase, params.viewerUserId, generation.user_id);
  try {
    if (!ownedByViewer) {
      const viewer = await adminSupabase.auth.admin.getUserById(params.viewerUserId);
      if (viewer.error) throw viewer.error;
      if (!viewer.data.user || isGuestUser(viewer.data.user)) return { outcome: 'not-eligible' };
    }
    const access = await resolveRemixAccess({
      adminSupabase,
      viewerUserId: params.viewerUserId,
      generation,
      dependencies: {
        isOwnOrLinkedAccountId: async () => ownedByViewer,
        isUserRelationshipBlocked: params.dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
      },
    });
    if (!access.allowed) return { outcome: 'not-eligible' };
  } catch (error) {
    logBackendError('failed_to_resolve_remix_access_for_remix_result', { error });
    return { outcome: 'failed' };
  }

  if (location.bucket === SHOWCASE_MEDIA_BUCKET) {
    const { data } = adminSupabase.storage.from(SHOWCASE_MEDIA_BUCKET).getPublicUrl(location.filePath);
    return data?.publicUrl ? { outcome: 'resolved', url: data.publicUrl } : { outcome: 'failed' };
  }
  const signed = await adminSupabase.storage
    .from(location.bucket)
    .createSignedUrl(location.filePath, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    logBackendError('failed_to_sign_remix_result_media', { error: signed.error });
    return { outcome: 'failed' };
  }
  return { outcome: 'resolved', url: signed.data.signedUrl };
}
