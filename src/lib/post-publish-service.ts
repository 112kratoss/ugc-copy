import 'server-only';

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
import { createPostMediaPreview } from '@/lib/post-media-preview';
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
        console.warn('Failed to remove uploaded showcase media after post failure:', cleanupShowcase.error);
      }
    }

    if (temporaryUploadPathsToCleanup.length > 0) {
      const cleanupUpload = await adminSupabase.storage
        .from(UPLOADS_BUCKET)
        .remove(temporaryUploadPathsToCleanup);
      if (cleanupUpload.error) {
        console.warn('Failed to remove temporary uploaded post media:', cleanupUpload.error);
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
        console.warn('Failed to remove uploaded unlock files after post failure:', cleanupFiles.error);
      }
    }
  };

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

      const showcaseUpload = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .upload(storagePath, mediaBody, {
          cacheControl: '3600',
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
        console.warn('Failed to create post media preview:', previewError);
      }

      persistedMediaItems.push({
        storagePath,
        previewStoragePath: preview?.previewStoragePath ?? null,
        previewThumbhash: preview?.previewThumbhash ?? null,
        previewStatus: preview?.previewStatus ?? 'failed',
        previewAttemptCount: 1,
        previewError: preview ? null : 'Preview generation failed.',
        previewGeneratedAt: preview ? new Date().toISOString() : null,
        mediaKind: getSubmittedMediaKind(mediaItem),
        contentType: mediaItem.contentType || mediaBody.type || null,
        originalName: mediaItem.originalName,
        width: preview?.width ?? null,
        height: preview?.height ?? null,
        sortOrder: index,
      });
    }
  } catch (mediaUploadError) {
    console.error('Failed to prepare uploaded post media:', mediaUploadError);
    await cleanupUploadedMedia();
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
    console.error('Failed to create external post:', publishError);
    await cleanupUploadedMedia();
    if (isMissingPostsSchemaError(publishError)) {
      return { ok: false, status: 500, body: { error: MISSING_POSTS_SCHEMA_ERROR } };
    }
    if (isMissingPostResourceBundlesSchemaError(publishError)) {
      return { ok: false, status: 500, body: { error: MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR } };
    }
    return { ok: false, status: 500, body: { error: 'Failed to create post.' } };
  }

  try {
    await resolvedDependencies.insertPostMediaItems({
      supabase: adminSupabase,
      postId: post.postId,
      mediaItems: persistedMediaItems,
    });
  } catch (mediaError) {
    console.error('Failed to save post media:', mediaError);
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
      console.warn('Failed to remove temporary uploaded post media:', cleanupUpload.error);
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
    console.error('Failed to insert post_source_tools:', sourceToolsError);
    await cleanupUploadedMedia();
    const cleanupPost = await adminSupabase
      .from('posts')
      .delete()
      .eq('id', post.postId);
    if (cleanupPost.error) {
      console.warn('Failed to remove post after source tool metadata failure:', cleanupPost.error);
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
          ? `/post/${post.postId}/edit#resources`
          : `/showcase/${post.postId}#resources`,
      resourceBundleStatus: post.bundleStatus,
    },
  };
}
