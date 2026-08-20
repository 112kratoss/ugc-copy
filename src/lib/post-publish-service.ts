import 'server-only';
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isMissingPostsSchemaError,
  isMissingPostResourceBundlesSchemaError,
} from '@/lib/posts-server';
import {
  createPostWithResourceBundleAtomically,
  getMarketplaceQualityErrorForPostBundle,
  updatePostWithResourceBundleAtomically,
  type PostResourceBundleMutationResult,
} from '@/lib/post-resource-bundles-server';
import {
  normalizePostResourceAttachments,
  normalizePostResourceItems,
  type PostResourceBundleStatus,
} from '@/lib/post-resource-bundles';
import { insertPostSourceTools, PostSourceToolsWriteError } from '@/lib/post-source-tools-server';
import {
  insertPostMediaItems,
  isMissingPostMediaSchemaError,
  type PostMediaPersistInput,
} from '@/lib/post-media';
import {
  getConfirmedRemovedPaths,
  markMediaUploadIntentsConsumed,
} from '@/lib/media-upload-intents';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { createPostMediaRendition, type PostMediaTeaserOutcome } from '@/lib/post-media-rendition';
import type { VideoProbeResult } from '@/lib/video-rendition';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import {
  getPublicUgcSafetyViolation,
  PUBLIC_UGC_SAFETY_ERROR,
} from '@/lib/public-ugc-safety';
import {
  isCreatorProfileCheckError,
  isCreatorProfileReadinessError,
} from '@/lib/marketplace-trust';
import {
  getSubmittedMediaKind,
  inferExtension,
  sanitizeFileStem,
  type PostCreationSubmission,
} from '@/lib/post-creation-submission-service';
import type { ShowcaseVisibility } from '@/lib/showcase';
import { formatUploadByteLimit, getMaxUploadBytesForContentType } from '@/lib/temporary-media-upload-sign';
import { finalizeUploadForConsumption } from '@/lib/upload-finalization';
import {
  abortNullableUploadByteConsumption,
  completeUploadByteConsumptions,
  DefinitiveSupabaseMutationRejection,
  type UploadConsumptionClaim,
} from '@/lib/upload-byte-admission';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

const SHOWCASE_MEDIA_BUCKET = 'showcase_media';
const UPLOADS_BUCKET = 'uploads';
const POST_RESOURCE_FILES_BUCKET = 'post_resource_files';

const MISSING_POSTS_SCHEMA_ERROR =
  'Posts are not enabled on the connected Supabase project yet. Apply the posts migrations and try again.';
const MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR =
  'Posts are working, but atomic unlock publishing is not enabled on the connected Supabase project yet. Apply the post resource bundle migrations, including 20260508120000_post_system_marketplace_reliability.sql, and try again.';
const MISSING_POST_MEDIA_SCHEMA_ERROR =
  'Posts are working, but multi-media gallery storage is not enabled on the connected Supabase project yet. Apply the post media gallery migration 20260609094006_post_media_gallery.sql and try again.';

export type PostPublishDependencies = {
  getMarketplaceQualityErrorForPostBundle?: typeof getMarketplaceQualityErrorForPostBundle;
  createPostWithResourceBundleAtomically?: typeof createPostWithResourceBundleAtomically;
  updatePostWithResourceBundleAtomically?: typeof updatePostWithResourceBundleAtomically;
  insertPostMediaItems?: typeof insertPostMediaItems;
  insertPostSourceTools?: typeof insertPostSourceTools;
  createPostMediaPreview?: typeof createPostMediaPreview;
  createPostMediaRendition?: typeof createPostMediaRendition;
};

type ResolvedPostPublishDependencies = Required<PostPublishDependencies>;

export type PostPublishResult =
  | {
      ok: true;
      body: {
        success: true;
        postId: string;
        visibility: ShowcaseVisibility;
        showcasePath: string | null;
        ownerPath: string;
        resourceBundlePath: string;
        resourceBundleStatus: PostResourceBundleStatus | null;
      };
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      body: {
        error: string;
        field?: string;
        actionHref?: string;
        actionLabel?: string;
      };
    };

function resolveDependencies(dependencies: PostPublishDependencies | undefined): ResolvedPostPublishDependencies {
  return {
    getMarketplaceQualityErrorForPostBundle:
      dependencies?.getMarketplaceQualityErrorForPostBundle ?? getMarketplaceQualityErrorForPostBundle,
    createPostWithResourceBundleAtomically:
      dependencies?.createPostWithResourceBundleAtomically ?? createPostWithResourceBundleAtomically,
    updatePostWithResourceBundleAtomically:
      dependencies?.updatePostWithResourceBundleAtomically ?? updatePostWithResourceBundleAtomically,
    insertPostMediaItems: dependencies?.insertPostMediaItems ?? insertPostMediaItems,
    insertPostSourceTools: dependencies?.insertPostSourceTools ?? insertPostSourceTools,
    createPostMediaPreview: dependencies?.createPostMediaPreview ?? createPostMediaPreview,
    createPostMediaRendition: dependencies?.createPostMediaRendition ?? createPostMediaRendition,
  };
}

function getSubmissionSourceMediaKind(submission: PostCreationSubmission): 'image' | 'video' | null {
  if (submission.mediaMimeType.startsWith('image/')) {
    return 'image';
  }

  if (submission.mediaMimeType.startsWith('video/')) {
    return 'video';
  }

  return null;
}

export async function publishPreparedPost({
  adminSupabase,
  ownerUserId,
  postId,
  submission,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  ownerUserId: string;
  postId: string;
  submission: PostCreationSubmission;
  dependencies?: PostPublishDependencies;
}): Promise<PostPublishResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const safetyViolation = submission.visibility !== 'private'
    ? getPublicUgcSafetyViolation({
        title: submission.title,
        description: submission.description,
        body: submission.body,
        resourcePrompt: submission.resourceBundle?.resources?.promptText ?? null,
        resourceNotes: submission.resourceBundle?.resources?.notesMarkdown ?? null,
      })
    : null;

  if (safetyViolation) {
    return {
      ok: false,
      status: 400,
      body: {
        error: PUBLIC_UGC_SAFETY_ERROR,
        field: safetyViolation.field,
      },
    };
  }

  const marketplaceQualityError = submission.visibility === 'public'
    ? await resolvedDependencies.getMarketplaceQualityErrorForPostBundle({
        supabase: adminSupabase,
        ownerUserId,
        post: {
          title: submission.title,
          body: submission.body,
          visibility: submission.visibility,
          archivedAt: null,
          reviewStatus: 'visible',
          hasMedia: submission.hasSubmittedMedia,
        },
        bundle: submission.resourceBundle,
      })
    : null;

  if (marketplaceQualityError) {
    const needsProfileRepair = isCreatorProfileReadinessError(marketplaceQualityError);
    const profileCheckFailed = isCreatorProfileCheckError(marketplaceQualityError);
    return {
      ok: false,
      status: profileCheckFailed ? 500 : 400,
      body: {
        error: marketplaceQualityError,
        ...(needsProfileRepair
          ? {
              field: 'profile',
              actionHref: '/profile',
              actionLabel: 'Complete profile and return',
            }
          : {}),
      },
    };
  }

  const persistedMediaItems: PostMediaPersistInput[] = [];
  const storagePathsToCleanup: string[] = [];
  const temporaryUploadPathsToCleanup: string[] = [];
  const mediaConsumptionClaims: UploadConsumptionClaim[] = [];
  const resourceConsumptionClaims: UploadConsumptionClaim[] = [];
  const finalizedUploadedMedia = new Map<string, {
    canonicalPath: string;
    descriptor: { sizeBytes: number; contentType: string } | null;
  }>();

  const abortPreparedClaims = async () => {
    await Promise.all([
      ...mediaConsumptionClaims,
      ...resourceConsumptionClaims,
    ].map((claim) => abortNullableUploadByteConsumption(adminSupabase, claim)));
  };

  const cleanupUploadedMedia = async () => {
    if (storagePathsToCleanup.length > 0) {
      try {
        const cleanupShowcase = await adminSupabase.storage
          .from(SHOWCASE_MEDIA_BUCKET)
          .remove(storagePathsToCleanup);
        if (cleanupShowcase.error) {
          logBackendWarning('failed_to_remove_uploaded_showcase_media_after_post_failure', { error: cleanupShowcase.error });
        }
      } catch (error) {
        logBackendWarning('failed_to_remove_uploaded_showcase_media_after_post_failure', { error });
      }
    }
  };

  let mediaRejection: string | null = null;

  try {
    for (const [index, mediaItem] of submission.submittedMediaItems.entries()) {
      const extension = inferExtension(mediaItem.originalName, mediaItem.contentType);
      const storagePath = `posts/${postId}/${index}/${sanitizeFileStem(mediaItem.originalName)}.${extension}`;
      let mediaKind = getSubmittedMediaKind(mediaItem);

      if (mediaItem.source === 'uploaded') {
        // Staged bytes are already in Storage, so the object moves between
        // buckets server-side. Nothing is pulled into this function: a 250 MB
        // video used to be downloaded, re-uploaded, and transcoded inline,
        // which is the whole latency and memory profile of a publish.
        //
        // The tradeoff `copy()` forces: it carries the source object's
        // cache-control and offers no override, which is why both clients stage
        // at the public 300s policy.
        let finalizedSource = finalizedUploadedMedia.get(mediaItem.filePath);
        if (!finalizedSource) {
          const finalization = await finalizeUploadForConsumption(adminSupabase, {
            bucket: UPLOADS_BUCKET,
            storagePath: mediaItem.filePath,
            userId: ownerUserId,
            disposition: 'delete',
          });
          if (!finalization.ok) {
            mediaRejection = finalization.error;
            throw new Error('post_media_upload_finalization_failed');
          }
          if (finalization.consumptionClaim) {
            mediaConsumptionClaims.push(finalization.consumptionClaim);
          }
          finalizedSource = {
            canonicalPath: finalization.canonicalPath,
            descriptor: finalization.descriptor,
          };
          finalizedUploadedMedia.set(mediaItem.filePath, finalizedSource);
          finalizedUploadedMedia.set(finalization.canonicalPath, finalizedSource);
        }
        const canonicalSourcePath = finalizedSource.canonicalPath;

        const info = finalizedSource.descriptor
          ? {
              data: {
                size: finalizedSource.descriptor.sizeBytes,
                contentType: finalizedSource.descriptor.contentType,
              },
              error: null,
            }
          : await adminSupabase.storage.from(UPLOADS_BUCKET).info(canonicalSourcePath);
        const storedSize = (info.data as { size?: unknown } | null | undefined)?.size;
        if (info.error || typeof storedSize !== 'number') {
          // Fail closed. The sign step could only trust a client-declared size,
          // so this metadata read is the only authoritative check there is --
          // proceeding without it makes the 25 MB image cap decoration and the
          // real ceiling the bucket's 250 MB. Nothing is registered for cleanup
          // here: a metadata failure is retryable, and deleting the staged
          // object would turn that retry into a permanent failure. The reclaim
          // sweep owns anything left behind.
          throw info.error ?? new Error('Uploaded media metadata was unavailable.');
        }

        // The object is confirmed to exist, so every rejection from here on
        // must roll it back -- an oversized upload can never be published, and
        // leaving it in the staging bucket reintroduces the exact leak the
        // intents table was built to end.
        if (!temporaryUploadPathsToCleanup.includes(canonicalSourcePath)) {
          temporaryUploadPathsToCleanup.push(canonicalSourcePath);
        }
        // Registered before the copy, not after: a copy that materializes the
        // destination and then fails to answer would otherwise leak an object
        // no cleanup knows about. Removing a path that was never written is a
        // no-op, so the pessimistic order costs nothing.
        storagePathsToCleanup.push(storagePath);

        const infoContentType = (info.data as { contentType?: unknown } | null | undefined)?.contentType;
        const resolvedContentType = (typeof infoContentType === 'string' ? infoContentType : '')
          || mediaItem.contentType
          || null;
        mediaKind = getSubmittedMediaKind({
          ...mediaItem,
          contentType: resolvedContentType ?? mediaItem.contentType,
        });
        const maxBytes = getMaxUploadBytesForContentType(resolvedContentType);
        if (maxBytes !== null && storedSize > maxBytes) {
          mediaRejection = `${mediaItem.originalName || 'That file'} is larger than the ${formatUploadByteLimit(maxBytes)} limit for this media type.`;
          throw new Error('post_media_exceeds_size_limit');
        }

        const showcaseCopy = await adminSupabase.storage
          .from(UPLOADS_BUCKET)
          .copy(canonicalSourcePath, storagePath, { destinationBucket: SHOWCASE_MEDIA_BUCKET });
        if (showcaseCopy.error) {
          throw showcaseCopy.error;
        }

        // Video work is deferred entirely: the transcode is the expensive part
        // and the feed falls back to the source until it lands. Images keep an
        // inline preview because the thumbhash placeholder is what the feed
        // renders first, and an image is capped at 25 MB.
        let preview: Awaited<ReturnType<typeof createPostMediaPreview>> = null;
        if (mediaKind === 'image') {
          try {
            const downloadedMedia = await adminSupabase.storage
              .from(UPLOADS_BUCKET)
              .download(canonicalSourcePath);
            if (downloadedMedia.error || !downloadedMedia.data) {
              throw downloadedMedia.error ?? new Error('Failed to load uploaded media.');
            }

            preview = await resolvedDependencies.createPostMediaPreview({
              body: downloadedMedia.data,
              contentType: resolvedContentType || downloadedMedia.data.type,
              storagePath,
              supabase: adminSupabase,
            });
            if (preview?.previewStoragePath) {
              storagePathsToCleanup.push(preview.previewStoragePath);
            }
          } catch (previewError) {
            logBackendWarning('failed_to_create_post_media_preview', { error: previewError });
          }
        }

        persistedMediaItems.push({
          mediaKey: mediaItem.mediaKey,
          storagePath,
          // Preview and rendition fields are omitted rather than marked failed
          // when there is nothing to record: insertPostMediaItems defaults them
          // to pending with zero attempts, which is the state the repair sweep
          // acts on. Writing `failed`/1 here would spend one of three attempts
          // on work that was never tried.
          ...(preview
            ? {
              previewStoragePath: preview.previewStoragePath,
              previewThumbhash: preview.previewThumbhash,
              previewStatus: preview.previewStatus,
              previewAttemptCount: 1,
              previewError: null,
              previewGeneratedAt: new Date().toISOString(),
            }
            : {}),
          mediaKind,
          contentType: resolvedContentType,
          originalName: mediaItem.originalName,
          width: preview?.width ?? null,
          height: preview?.height ?? null,
          // Client-reported seed; the rendition sweep's probe of the actual
          // file overwrites it and is the value of record.
          durationSeconds: mediaKind === 'video' ? mediaItem.durationSeconds ?? null : null,
          sortOrder: index,
        });
        continue;
      }

      // The legacy multipart path still arrives as bytes in the request, so
      // there is nothing to copy and the work is already in memory.
      const mediaBody = mediaItem.file;

      const maxBytes = getMaxUploadBytesForContentType(mediaItem.contentType || mediaBody.type);
      if (maxBytes !== null && typeof mediaBody.size === 'number' && mediaBody.size > maxBytes) {
        mediaRejection = `${mediaItem.originalName || 'That file'} is larger than the ${formatUploadByteLimit(maxBytes)} limit for this media type.`;
        throw new Error('post_media_exceeds_size_limit');
      }

      const showcaseUpload = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .upload(storagePath, mediaBody, {
          cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL,
          contentType: mediaBody.type || mediaItem.contentType || undefined,
          upsert: false,
        });

      if (showcaseUpload.error) {
        throw showcaseUpload.error;
      }

      storagePathsToCleanup.push(storagePath);
      let preview: Awaited<ReturnType<typeof createPostMediaPreview>> = null;
      try {
        preview = await resolvedDependencies.createPostMediaPreview({
          body: mediaBody,
          contentType: mediaItem.contentType || mediaBody.type,
          storagePath,
          supabase: adminSupabase,
        });
        if (preview?.previewStoragePath) {
          storagePathsToCleanup.push(preview.previewStoragePath);
        }
      } catch (previewError) {
        logBackendWarning('failed_to_create_post_media_preview', { error: previewError });
      }

      // A missing rendition costs bandwidth, never correctness — the feed falls
      // back to the source and the repair sweep retries. Publishing must not
      // fail because a transcode did.
      let rendition: Awaited<ReturnType<typeof createPostMediaRendition>> | null = null;
      let renditionFailed = false;
      // Object properties, not bare lets: the values land via callbacks, and
      // TypeScript's flow analysis would otherwise keep a bare let narrowed to
      // its null initializer at every later read.
      const captured: {
        inputProbe: VideoProbeResult | null;
        teaserOutcome: PostMediaTeaserOutcome | null;
      } = { inputProbe: null, teaserOutcome: null };
      try {
        rendition = await resolvedDependencies.createPostMediaRendition({
          body: mediaBody,
          contentType: mediaItem.contentType || mediaBody.type,
          storagePath,
          supabase: adminSupabase,
          onInputProbe: (probe) => { captured.inputProbe = probe; },
          onTeaserOutcome: (outcome) => { captured.teaserOutcome = outcome; },
        });
        if (rendition.status === 'ready') {
          storagePathsToCleanup.push(rendition.renditionStoragePath);
        }
      } catch (renditionError) {
        renditionFailed = true;
        logBackendWarning('failed_to_create_post_media_rendition', { error: renditionError });
      }
      const teaserOutcome = captured.teaserOutcome;
      const inputProbe = captured.inputProbe;
      if (teaserOutcome?.status === 'ready') {
        storagePathsToCleanup.push(teaserOutcome.teaserStoragePath);
      }

      persistedMediaItems.push({
        mediaKey: mediaItem.mediaKey,
        storagePath,
        previewStoragePath: preview?.previewStoragePath ?? null,
        previewThumbhash: preview?.previewThumbhash ?? null,
        previewStatus: preview?.previewStatus ?? 'failed',
        previewAttemptCount: 1,
        previewError: preview ? null : 'Preview generation failed.',
        previewGeneratedAt: preview ? new Date().toISOString() : null,
        renditionStoragePath: rendition?.status === 'ready' ? rendition.renditionStoragePath : null,
        renditionStatus: rendition?.status === 'ready'
          ? 'ready'
          : rendition?.status === 'skipped'
            ? 'skipped'
            : renditionFailed
              ? 'failed'
              : mediaKind === 'video' ? 'pending' : 'skipped',
        renditionAttemptCount: mediaKind === 'video' ? 1 : 0,
        renditionError: renditionFailed ? 'Rendition generation failed.' : null,
        renditionGeneratedAt: rendition?.status === 'ready' ? new Date().toISOString() : null,
        renditionBytes: rendition?.status === 'ready' ? rendition.renditionBytes : null,
        teaserStoragePath: teaserOutcome?.status === 'ready' ? teaserOutcome.teaserStoragePath : null,
        teaserBytes: teaserOutcome?.status === 'ready' ? teaserOutcome.teaserBytes : null,
        teaserGeneratedAt: teaserOutcome?.status === 'ready' ? new Date().toISOString() : null,
        teaserError: teaserOutcome?.status === 'failed' ? teaserOutcome.error.slice(0, 500) : null,
        mediaKind,
        contentType: mediaItem.contentType || mediaBody.type || null,
        originalName: mediaItem.originalName,
        width: preview?.width ?? (rendition?.status === 'ready' ? rendition.width : null),
        height: preview?.height ?? (rendition?.status === 'ready' ? rendition.height : null),
        // Output probe first, input probe when the transcode never finished.
        durationSeconds: (rendition?.status === 'ready' ? rendition.durationSeconds : null)
          ?? inputProbe?.durationSeconds
          ?? null,
        sortOrder: index,
      });
    }
  } catch (mediaUploadError) {
    await abortPreparedClaims();
    await cleanupUploadedMedia();
    if (mediaRejection) {
      return { ok: false, status: 400, body: { error: mediaRejection } };
    }

    logBackendError('failed_to_prepare_uploaded_post_media', { error: mediaUploadError });
    return { ok: false, status: 500, body: { error: 'Failed to prepare uploaded media.' } };
  }

  const coverMedia = persistedMediaItems[0] ?? null;
  const submittedResourceFilePaths = Array.from(new Set([
    ...normalizePostResourceAttachments(submission.resourceBundle?.resources?.attachments)
      .filter((attachment) => attachment.kind === 'file' && attachment.storagePath)
      .map((attachment) => attachment.storagePath as string),
    ...normalizePostResourceItems(
      submission.resourceBundle?.resources?.items,
      submission.resourceBundle?.resources,
    )
      .filter((item) => item.storagePath)
      .map((item) => item.storagePath as string),
  ]));
  try {
    for (const submittedPath of submittedResourceFilePaths) {
      const canonicalPath = parseCanonicalStorageObjectPath(submittedPath, {
        ownerUserId,
      });
      if (!canonicalPath) {
        await abortPreparedClaims();
        await cleanupUploadedMedia();
        return { ok: false, status: 400, body: { error: 'Resource files must belong to the authenticated user.' } };
      }
      const finalization = await finalizeUploadForConsumption(adminSupabase, {
        bucket: POST_RESOURCE_FILES_BUCKET,
        storagePath: canonicalPath,
        userId: ownerUserId,
        disposition: 'preserve',
      });
      if (!finalization.ok) {
        await abortPreparedClaims();
        await cleanupUploadedMedia();
        return { ok: false, status: finalization.status, body: { error: finalization.error } };
      }
      if (finalization.consumptionClaim) {
        resourceConsumptionClaims.push(finalization.consumptionClaim);
      }
    }
  } catch (error) {
    await abortPreparedClaims();
    await cleanupUploadedMedia();
    logBackendError('failed_to_prepare_post_resource_uploads', { error });
    return { ok: false, status: 500, body: { error: 'Failed to prepare resource uploads.' } };
  }
  // The post is created private no matter what was requested, and promoted to
  // the requested visibility only after media and source tools are all in.
  // Post-then-media is not one transaction, so creating at the final visibility
  // opened a window — permanent, if the compensating delete also failed — where
  // a public post existed with no media rows. Nothing here is visible until
  // everything it needs exists.
  const requestedVisibility = submission.visibility;
  let post: PostResourceBundleMutationResult;
  try {
    post = await resolvedDependencies.createPostWithResourceBundleAtomically({
      supabase: adminSupabase,
      post: {
        id: postId,
        user_id: ownerUserId,
        visibility: 'private',
        category: submission.category,
        title: submission.title,
        description: submission.description,
        prompt: null,
        body: submission.body,
        post_format: submission.postFormat,
        source_kind: submission.sourceKind,
        source_tool: submission.sourceTools.length > 0
          ? submission.sourceTools[0].toolLabel
          : submission.normalizedSourceTool.label,
        source_tool_slug: submission.sourceTools.length > 0
          ? submission.sourceTools[0].toolSlug
          : submission.normalizedSourceTool.slug,
        showcase_asset_path: coverMedia?.storagePath ?? null,
        output_url: null,
      },
      bundle: submission.resourceBundle,
    });
  } catch (publishError) {
    logBackendError('failed_to_create_external_post', { error: publishError });
    if (publishError instanceof DefinitiveSupabaseMutationRejection) {
      await abortPreparedClaims();
      await cleanupUploadedMedia();
    }
    if (isMissingPostsSchemaError(publishError)) {
      return { ok: false, status: 500, body: { error: MISSING_POSTS_SCHEMA_ERROR } };
    }
    if (isMissingPostResourceBundlesSchemaError(publishError)) {
      return { ok: false, status: 500, body: { error: MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR } };
    }
    return { ok: false, status: 500, body: { error: 'Failed to create post.' } };
  }

  // The atomic post+bundle mutation is the durable boundary for both copied
  // media and resource references. From here on a compensating delete may fail,
  // so claims must be completed before any later enrichment work.
  const completedClaims = await completeUploadByteConsumptions(adminSupabase, [
    ...mediaConsumptionClaims,
    ...resourceConsumptionClaims,
  ]);
  if (!completedClaims.ok) {
    return { ok: false, status: 500, body: { error: completedClaims.error } };
  }

  let didMutateSharedFeed = false;

  try {
    try {
      await resolvedDependencies.insertPostMediaItems({
        supabase: adminSupabase,
        postId: post.postId,
        mediaItems: persistedMediaItems,
      });
    } catch (mediaError) {
      logBackendError('failed_to_save_post_media', { error: mediaError });
      const cleanupPost = await adminSupabase.from('posts').delete().eq('id', post.postId);
      if (cleanupPost.error) {
        // A warning is enough: the leftover shell is private, so nothing broken
        // is reachable — this row is cruft, not a user-facing post.
        logBackendWarning('failed_to_remove_post_after_media_failure', { error: cleanupPost.error });
      }
      if (isMissingPostMediaSchemaError(mediaError)) {
        return { ok: false, status: 500, body: { error: MISSING_POST_MEDIA_SCHEMA_ERROR } };
      }
      return { ok: false, status: 500, body: { error: 'Failed to save post media.' } };
    }

    if (temporaryUploadPathsToCleanup.length > 0) {
      const cleanupUpload = await adminSupabase.storage
        .from(UPLOADS_BUCKET)
        .remove(temporaryUploadPathsToCleanup);
      if (cleanupUpload.error) {
        logBackendWarning('failed_to_remove_temporary_uploaded_post_media', { error: cleanupUpload.error });
      }

      // Only what storage confirmed deleted is marked cleared. A failed or
      // partial remove stays consumed-but-uncleared, which is exactly the state
      // the reclaim sweep retries -- marking it cleared would hide the object
      // from the sweep forever.
      const removal = getConfirmedRemovedPaths(temporaryUploadPathsToCleanup, cleanupUpload);
      if (removal.confirmed.length > 0) {
        await markMediaUploadIntentsConsumed(adminSupabase, {
          storagePaths: removal.confirmed,
          userId: ownerUserId,
          consumedBy: 'post_publish',
          storageCleared: true,
        });
      }
      if (removal.unconfirmed.length > 0) {
        if (!cleanupUpload.error) {
          logBackendWarning('partially_removed_temporary_uploaded_post_media', {
            requested: temporaryUploadPathsToCleanup.length,
            removed: removal.confirmed.length,
          });
        }
        await markMediaUploadIntentsConsumed(adminSupabase, {
          storagePaths: removal.unconfirmed,
          userId: ownerUserId,
          consumedBy: 'post_publish',
          storageCleared: false,
        });
      }
    }

    try {
      await resolvedDependencies.insertPostSourceTools({
        supabase: adminSupabase,
        postId: post.postId,
        ownerUserId,
        mediaKind: getSubmissionSourceMediaKind(submission),
        sourceTools: submission.sourceTools,
      });
    } catch (sourceToolsError) {
      logBackendError('failed_to_insert_post_source_tools', { error: sourceToolsError });
      const cleanupPost = await adminSupabase
        .from('posts')
        .delete()
        .eq('id', post.postId);
      if (cleanupPost.error) {
        logBackendWarning('failed_to_remove_post_after_source_tool_metadata_failure', { error: cleanupPost.error });
      }
      const isValidationError = sourceToolsError instanceof PostSourceToolsWriteError
        && sourceToolsError.isValidationError;
      return {
        ok: false,
        status: isValidationError ? 400 : 500,
        body: {
          error: isValidationError ? sourceToolsError.message : 'Failed to save source tool metadata.',
          field: isValidationError ? 'sourceTools' : undefined,
        },
      };
    }

    let finalVisibility = post.visibility;
    let finalBundleStatus = post.bundleStatus;
    if (requestedVisibility !== 'private') {
      try {
        // The update RPC, not a bare visibility write: going public has to rerun
        // the bundle mutation, because both RPCs force bundles to draft while a
        // post is non-public — a bare write would leave a paid bundle stuck in
        // draft on a live post. The sparse patch keeps every other field.
        const promoted = await resolvedDependencies.updatePostWithResourceBundleAtomically({
          supabase: adminSupabase,
          postId: post.postId,
          ownerUserId,
          patch: { visibility: requestedVisibility },
          hasBundlePayload: true,
          bundle: submission.resourceBundle,
        });
        finalVisibility = promoted.visibility;
        finalBundleStatus = promoted.bundleStatus;
        didMutateSharedFeed = finalVisibility === 'public';
      } catch (promoteError) {
        // Everything the user made exists, just privately. Do not tear it down —
        // report the failure and let them publish from the editor.
        logBackendError('failed_to_promote_created_post', { error: promoteError });
        return {
          ok: false,
          status: 500,
          body: {
            error: 'Your post was saved as a private draft, but publishing failed. Open it from your posts to publish again.',
          },
        };
      }
    }

    return {
      ok: true,
      body: {
        success: true,
        postId: post.postId,
        visibility: finalVisibility,
        showcasePath: finalVisibility === 'private' ? null : `/showcase/${post.postId}`,
        ownerPath: `/post/${post.postId}/edit`,
        resourceBundlePath:
          finalBundleStatus === 'draft' || finalVisibility === 'private'
            ? `/post/${post.postId}/edit#recipe`
            : `/showcase/${post.postId}#recipe`,
        resourceBundleStatus: finalBundleStatus,
      },
    };
  } finally {
    if (didMutateSharedFeed) {
      invalidateShowcaseFeedCache();
    }
  }
}
