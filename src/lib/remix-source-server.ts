import 'server-only';

import type { NextRequest } from 'next/server';

import { getUploadsBucketPath, isUploadsStoragePath, normalizeSubmittedElementDescriptors } from '@/lib/image-elements';
import {
  buildLegacyGenerationInputMedia,
  loadGenerationInputMediaMap,
  sanitizeWorkflowSettingsForRemix,
  toRemixAssetDescriptor,
  toRemixImageElement,
  type GenerationInputMediaItem,
} from '@/lib/generation-input-media';
import { isAudioModel, isImageModel, isMotionModel } from '@/lib/models';
import {
  type RemixMediaAssetDescriptor,
  normalizeRemixMediaAssetDescriptor,
  type RemixResolvedAsset,
  type RemixResolvedImageElement,
  type RemixSourceBundle,
  type RemixSourceResult,
} from '@/lib/remix-source';
import { loadGenerationRecipeRemixInputMediaByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient, createUserClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import type { ShowcaseItemCategory } from '@/lib/showcase';

type RemixSourceGenerationRow = {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  share_input_media_for_remix?: boolean | null;
  output_url: string | null;
  showcase_asset_path: string | null;
  category: string | null;
  model: string | null;
  prompt: string | null;
  title: string | null;
  workflow_settings: Record<string, unknown> | null;
};

type ResultGenerationRow = Pick<
  RemixSourceGenerationRow,
  'id' | 'user_id' | 'is_public' | 'output_url' | 'showcase_asset_path'
>;

const GENERATION_SELECT =
  'id, user_id, is_public, share_input_media_for_remix, output_url, showcase_asset_path, category, model, prompt, title, workflow_settings';

export class RemixSourceError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RemixSourceError';
    this.status = status;
  }
}

function normalizeCategory(category: string | null, model: string | null): ShowcaseItemCategory | null {
  if (category === 'motion' || category === 'ugc-ad') return 'video';
  if (category === 'image' || category === 'video') return category;

  if (!model) {
    return null;
  }

  if (isImageModel(model)) {
    return 'image';
  }

  if (isMotionModel(model)) {
    return 'video';
  }

  if (isAudioModel(model)) {
    return null;
  }

  return 'video';
}

function toResultMediaType(category: ShowcaseItemCategory): RemixSourceResult['mediaType'] {
  return category === 'image' ? 'image' : 'video';
}

function getShowcaseAssetUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  showcaseAssetPath: string
): string {
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(showcaseAssetPath);
  return data.publicUrl;
}

async function resolveGenerationResultUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generation: ResultGenerationRow
): Promise<string | null> {
  if (generation.showcase_asset_path) {
    return getShowcaseAssetUrl(adminSupabase, generation.showcase_asset_path);
  }

  if (!generation.output_url) {
    return null;
  }

  return resolveStoredMediaUrl(adminSupabase, generation.output_url);
}

async function resolveUploadsStoragePathUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  storagePath: string,
  allowedOwnerUserId: string | null
): Promise<string | null> {
  if (!isUploadsStoragePath(storagePath)) {
    return null;
  }

  const filePath = getUploadsBucketPath(storagePath);
  const storageOwnerId = filePath.split('/')[0]?.trim();
  if (!storageOwnerId || storageOwnerId !== allowedOwnerUserId) {
    return null;
  }

  const { data, error } = await adminSupabase.storage.from('uploads').createSignedUrl(filePath, 3600);

  if (error || !data?.signedUrl) {
    console.error('Failed to sign remix source upload asset:', error);
    return null;
  }

  return data.signedUrl;
}

async function fetchGenerationById(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generationId: string,
  allowedOwnerUserId: string | null
): Promise<ResultGenerationRow | null> {
  const { data, error } = await adminSupabase
    .from('generations')
    .select('id, user_id, is_public, output_url, showcase_asset_path')
    .eq('id', generationId)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch remix referenced generation:', error);
    return null;
  }

  const generation = data as ResultGenerationRow | null;
  if (!generation) {
    return null;
  }

  if (generation.user_id !== allowedOwnerUserId && !generation.is_public) {
    return null;
  }

  return generation;
}

export async function loadRemixSourceBundle(
  request: NextRequest,
  generationId: string,
  options?: {
    postId?: string | null;
  }
): Promise<RemixSourceBundle> {
  const trimmedGenerationId = generationId.trim();
  if (!trimmedGenerationId) {
    throw new RemixSourceError('Missing generation ID', 400);
  }

  const userSupabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await userSupabase.auth.getUser();

  if (authError || !user) {
    throw new RemixSourceError('Unauthorized', 401);
  }

  const adminSupabase = createServiceClient();
  const { data: generation, error } = await adminSupabase
    .from('generations')
    .select(GENERATION_SELECT)
    .eq('id', trimmedGenerationId)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch remix source generation:', error);
    throw new RemixSourceError('Failed to load remix source', 500);
  }

  if (!generation) {
    throw new RemixSourceError('Remix source not found', 404);
  }

  const typedGeneration = generation as RemixSourceGenerationRow;
  const isOwner = typedGeneration.user_id === user.id;
  if (!isOwner && !typedGeneration.is_public) {
    throw new RemixSourceError('Remix source not found', 404);
  }

  const category = normalizeCategory(typedGeneration.category, typedGeneration.model);
  if (!category) {
    throw new RemixSourceError('This creation type does not support remix media restoration', 400);
  }

  const workflowSettings =
    typedGeneration.workflow_settings && typeof typedGeneration.workflow_settings === 'object'
      ? typedGeneration.workflow_settings
      : {};
  const isMotionWorkflow = typedGeneration.category === 'motion' || workflowSettings.creationMode === 'motion';
  const includeInputMedia = isOwner || (typedGeneration.is_public === true && typedGeneration.share_input_media_for_remix === true);
  const effectiveWorkflowSettings = sanitizeWorkflowSettingsForRemix(workflowSettings, includeInputMedia);
  const durableInputMediaMap = includeInputMedia
    ? await loadGenerationInputMediaMap({
        supabase: adminSupabase,
        generationIds: [typedGeneration.id],
        urlMode: 'signed',
      })
    : new Map<string, GenerationInputMediaItem[]>();
  let inputMedia = durableInputMediaMap.get(typedGeneration.id) ?? [];
  const hasDurableInputMedia = inputMedia.length > 0;

  if (includeInputMedia && !hasDurableInputMedia) {
    inputMedia = await buildLegacyGenerationInputMedia({
      supabase: adminSupabase,
      generationId: typedGeneration.id,
      ownerUserId: typedGeneration.user_id,
      category: typedGeneration.category,
      workflowSettings,
    });
  }

  const recipeInputMedia = !includeInputMedia && options?.postId
    ? await loadGenerationRecipeRemixInputMediaByPostId({
        postId: options.postId,
        generationId: typedGeneration.id,
        adminSupabase,
      })
    : [];
  const accessibleInputMedia = includeInputMedia ? inputMedia : recipeInputMedia;

  const restoreIssues: string[] = [];
  const referencedGenerationCache = new Map<string, Promise<ResultGenerationRow | null>>();

  const resolveDescriptorUrl = async (
    descriptor: RemixMediaAssetDescriptor,
    issueLabel: string
  ): Promise<string | null> => {
    if (descriptor.storagePath) {
      const signedUrl = await resolveUploadsStoragePathUrl(
        adminSupabase,
        descriptor.storagePath,
        typedGeneration.user_id
      );
      if (signedUrl) {
        return signedUrl;
      }

      restoreIssues.push(issueLabel);
      return null;
    }

    if (descriptor.sourceGenerationId) {
      const cacheKey = descriptor.sourceGenerationId;
      if (!referencedGenerationCache.has(cacheKey)) {
        referencedGenerationCache.set(
          cacheKey,
          fetchGenerationById(adminSupabase, cacheKey, typedGeneration.user_id)
        );
      }

      const referencedGeneration = await referencedGenerationCache.get(cacheKey)!;
      if (!referencedGeneration) {
        restoreIssues.push(issueLabel);
        return null;
      }

      const resolvedUrl = await resolveGenerationResultUrl(adminSupabase, referencedGeneration);
      if (resolvedUrl) {
        return resolvedUrl;
      }

      restoreIssues.push(issueLabel);
      return null;
    }

    restoreIssues.push(issueLabel);
    return null;
  };

  const resolveElementDescriptors = async (
    issuePrefix: string
  ): Promise<RemixResolvedImageElement[]> => {
    const elements = normalizeSubmittedElementDescriptors(workflowSettings.elements);

    return Promise.all(
      elements.map(async (element) => ({
        ...element,
        url: await resolveDescriptorUrl(
          {
            kind: 'image',
            label: element.displayName,
            storagePath: element.storagePath ?? null,
            sourceGenerationId: element.sourceGenerationId ?? null,
          },
          `${issuePrefix}:${element.displayName}`
        ),
      }))
    );
  };

  const resolveAssetDescriptor = async (
    value: unknown,
    expectedKind: 'image' | 'video',
    issueLabel: string
  ): Promise<RemixResolvedAsset | null> => {
    const descriptor = normalizeRemixMediaAssetDescriptor(value, expectedKind);
    if (!descriptor) {
      return null;
    }

    return {
      ...descriptor,
      url: await resolveDescriptorUrl(descriptor, issueLabel),
    };
  };

  const resultUrl = await resolveGenerationResultUrl(adminSupabase, typedGeneration);
  const result: RemixSourceResult | null = {
    mediaType: toResultMediaType(category),
    url: resultUrl,
  };

  if (!resultUrl) {
    restoreIssues.push('result');
  }

  const bundle: RemixSourceBundle = {
    generation: {
      id: typedGeneration.id,
      title: typedGeneration.title?.trim() || 'Untitled Creation',
      prompt: typedGeneration.prompt?.trim() || '',
      category,
      model: typedGeneration.model || '',
    },
    result,
    inputs: {},
    inputMedia: accessibleInputMedia,
    workflowSettings: effectiveWorkflowSettings,
    restoreIssues,
  };

  if (accessibleInputMedia.length > 0) {
    const referenceImages = accessibleInputMedia.filter((item) => item.mediaType === 'image' && item.role === 'reference_image');

    referenceImages.forEach((item, index) => {
      if (!item.url) {
        restoreIssues.push(`image-element:${item.label ?? `Reference image ${index + 1}`}`);
      }
    });

    if (category === 'image') {
      bundle.inputs.image = {
        elements: referenceImages.map((item, index) => toRemixImageElement(item, index)),
      };
    }

    if (category === 'video' && !isMotionWorkflow) {
      const startFrame = accessibleInputMedia.find((item) => item.role === 'start_frame');
      const endFrame = accessibleInputMedia.find((item) => item.role === 'end_frame');
      if (startFrame && !startFrame.url) {
        restoreIssues.push('video-start-frame');
      }
      if (endFrame && !endFrame.url) {
        restoreIssues.push('video-end-frame');
      }

      bundle.inputs.video = {
        referenceMode: workflowSettings.referenceMode === 'elements' ? 'elements' : 'frames',
        startFrame: startFrame ? toRemixAssetDescriptor(startFrame) : null,
        endFrame: endFrame ? toRemixAssetDescriptor(endFrame) : null,
        elements: referenceImages.map((item, index) => toRemixImageElement(item, index)),
        referenceVideos: accessibleInputMedia
          .filter((item) => item.mediaType === 'video' && item.role === 'reference_video')
          .map((item) => toRemixAssetDescriptor(item)),
        referenceAudios: accessibleInputMedia
          .filter((item) => item.mediaType === 'audio' && item.role === 'reference_audio')
          .map((item) => toRemixAssetDescriptor(item)),
      };
    }

    if (isMotionWorkflow) {
      const characterImage = accessibleInputMedia.find((item) => item.role === 'character_image');
      const referenceVideo = accessibleInputMedia.find((item) => item.role === 'motion_reference_video');
      if (characterImage && !characterImage.url) {
        restoreIssues.push('motion-character-image');
      }
      if (referenceVideo && !referenceVideo.url) {
        restoreIssues.push('motion-reference-video');
      }

      bundle.inputs.motion = {
        characterImage: characterImage ? toRemixAssetDescriptor(characterImage) : null,
        referenceVideo: referenceVideo ? toRemixAssetDescriptor(referenceVideo) : null,
      };
    }
  } else if (includeInputMedia) {
    if (category === 'image') {
      bundle.inputs.image = {
        elements: await resolveElementDescriptors('image-element'),
      };
    }

    if (category === 'video' && !isMotionWorkflow) {
      bundle.inputs.video = {
        referenceMode: workflowSettings.referenceMode === 'elements' ? 'elements' : 'frames',
        startFrame: await resolveAssetDescriptor(
          workflowSettings.startFrame,
          'image',
          'video-start-frame'
        ),
        endFrame: await resolveAssetDescriptor(workflowSettings.endFrame, 'image', 'video-end-frame'),
        elements: await resolveElementDescriptors('video-element'),
        referenceVideos: inputMedia
          .filter((item) => item.mediaType === 'video' && item.role === 'reference_video')
          .map((item) => toRemixAssetDescriptor(item)),
        referenceAudios: inputMedia
          .filter((item) => item.mediaType === 'audio' && item.role === 'reference_audio')
          .map((item) => toRemixAssetDescriptor(item)),
      };
    }

    if (isMotionWorkflow) {
      bundle.inputs.motion = {
        characterImage: await resolveAssetDescriptor(
          workflowSettings.characterImage,
          'image',
          'motion-character-image'
        ),
        referenceVideo: await resolveAssetDescriptor(
          workflowSettings.referenceVideo,
          'video',
          'motion-reference-video'
        ),
      };
    }
  }

  return bundle;
}
