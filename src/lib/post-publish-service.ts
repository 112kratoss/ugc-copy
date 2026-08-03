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
  markMediaUploadIntentsCleared,
  markMediaUploadIntentsConsumed,
} from '@/lib/media-upload-intents';
import { createPostMediaPreview } from '@/lib/post-media-preview';
import { createPostMediaRendition } from '@/lib/post-media-rendition';
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
      status: 400 | 500;
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

  const cleanupUploadedMedia = async () => {
    if (storagePathsToCleanup.length > 0) {
      const cleanupShowcase = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .remove(storagePathsToCleanup);
      if (cleanupShowcase.error) {
        logBackendWarning('failed_to_remove_uploaded_showcase_media_after_post_failure', { error: cleanupShowcase.error });
      }
    }

    if (temporaryUploadPathsToCleanup.length > 0) {
      const cleanupUpload = await adminSupabase.storage
        .from(UPLOADS_BUCKET)
        .remove(temporaryUploadPathsToCleanup);
      if (cleanupUpload.error) {
        logBackendWarning('failed_to_remove_temporary_uploaded_post_media', { error: cleanupUpload.error });
      }

      // Rolled back, so nothing consumed these -- but the bytes are gone and
      // the sweep should not go looking for them. Only confirmed deletions are
      // marked, though: a path the remove() did not actually delete keeps its
      // untouched row and is collected as an ordinary abandoned upload.
      const removal = getConfirmedRemovedPaths(temporaryUploadPathsToCleanup, cleanupUpload);
      if (removal.confirmed.length > 0) {
        await markMediaUploadIntentsCleared(adminSupabase, removal.confirmed);
      }
    }

    const legacyResourceFiles = normalizePostResourceAttachments(submission.resourceBundle?.resources?.attachments)
      .filter((attachment) => attachment.kind === 'file' && attachment.storagePath)
      .map((attachment) => attachment.storagePath as string);
    const itemResourceFiles = normalizePostResourceItems(
      submission.resourceBundle?.resources?.items,
      submission.resourceBundle?.resources,
    )
      .filter((item) => item.storagePath)
      .map((item) => item.storagePath as string);
    const resourceFilePathsToCleanup = Array.from(new Set([...legacyResourceFiles, ...itemResourceFiles]));
    if (resourceFilePathsToCleanup.length > 0) {
      const cleanupFiles = await adminSupabase.storage
        .from(POST_RESOURCE_FILES_BUCKET)
        .remove(resourceFilePathsToCleanup);
      if (cleanupFiles.error) {
        logBackendWarning('failed_to_remove_uploaded_unlock_files_after_post_failure', { error: cleanupFiles.error });
      }
    }
  };

  let mediaRejection: string | null = null;

  try {
    for (const [index, mediaItem] of submission.submittedMediaItems.entries()) {
      const extension = inferExtension(mediaItem.originalName, mediaItem.contentType);
      const storagePath = `posts/${postId}/${index}/${sanitizeFileStem(mediaItem.originalName)}.${extension}`;
      const mediaBody = mediaItem.source === 'file'
        ? mediaItem.file
        : await (async () => {
            const downloadedMedia = await adminSupabase.storage
              .from(UPLOADS_BUCKET)
              .download(mediaItem.filePath);
            if (downloadedMedia.error || !downloadedMedia.data) {
              throw new Error('Failed to load uploaded media.');
            }
            temporaryUploadPathsToCleanup.push(mediaItem.temporaryStoragePath);
            return downloadedMedia.data;
          })();

      // The signed-upload step could only trust a client-declared size. These
      // are the bytes we actually received, checked before anything reaches the
      // public bucket, where it would be world-readable and billed as egress.
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
      try {
        rendition = await resolvedDependencies.createPostMediaRendition({
          body: mediaBody,
          contentType: mediaItem.contentType || mediaBody.type,
          storagePath,
          supabase: adminSupabase,
        });
        if (rendition.status === 'ready') {
          storagePathsToCleanup.push(rendition.renditionStoragePath);
        }
      } catch (renditionError) {
        renditionFailed = true;
        logBackendWarning('failed_to_create_post_media_rendition', { error: renditionError });
      }

      const mediaKind = getSubmittedMediaKind(mediaItem);
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
        mediaKind,
        contentType: mediaItem.contentType || mediaBody.type || null,
        originalName: mediaItem.originalName,
        width: preview?.width ?? (rendition?.status === 'ready' ? rendition.width : null),
        height: preview?.height ?? (rendition?.status === 'ready' ? rendition.height : null),
        durationSeconds: rendition?.status === 'ready' ? rendition.durationSeconds : null,
        sortOrder: index,
      });
    }
  } catch (mediaUploadError) {
    await cleanupUploadedMedia();
    if (mediaRejection) {
      return { ok: false, status: 400, body: { error: mediaRejection } };
    }

    logBackendError('failed_to_prepare_uploaded_post_media', { error: mediaUploadError });
    return { ok: false, status: 500, body: { error: 'Failed to prepare uploaded media.' } };
  }

  const coverMedia = persistedMediaItems[0] ?? null;
  let post: PostResourceBundleMutationResult;
  try {
    post = await resolvedDependencies.createPostWithResourceBundleAtomically({
      supabase: adminSupabase,
      post: {
        id: postId,
        user_id: ownerUserId,
        visibility: submission.visibility,
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
    await cleanupUploadedMedia();
    if (isMissingPostsSchemaError(publishError)) {
      return { ok: false, status: 500, body: { error: MISSING_POSTS_SCHEMA_ERROR } };
    }
    if (isMissingPostResourceBundlesSchemaError(publishError)) {
      return { ok: false, status: 500, body: { error: MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR } };
    }
    return { ok: false, status: 500, body: { error: 'Failed to create post.' } };
  }

  const didMutateSharedFeed = post.visibility === 'public';

  try {
    try {
      await resolvedDependencies.insertPostMediaItems({
        supabase: adminSupabase,
        postId: post.postId,
        mediaItems: persistedMediaItems,
      });
    } catch (mediaError) {
      logBackendError('failed_to_save_post_media', { error: mediaError });
      await cleanupUploadedMedia();
      await adminSupabase.from('posts').delete().eq('id', post.postId);
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
      await cleanupUploadedMedia();
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

    return {
      ok: true,
      body: {
        success: true,
        postId: post.postId,
        visibility: post.visibility,
        showcasePath: post.visibility === 'private' ? null : `/showcase/${post.postId}`,
        ownerPath: `/post/${post.postId}/edit`,
        resourceBundlePath:
          post.bundleStatus === 'draft' || post.visibility === 'private'
            ? `/post/${post.postId}/edit#recipe`
            : `/showcase/${post.postId}#recipe`,
        resourceBundleStatus: post.bundleStatus,
      },
    };
  } finally {
    if (didMutateSharedFeed) {
      invalidateShowcaseFeedCache();
    }
  }
}
