import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendError } from '@/lib/backend-logger';

import type { NextRequest } from 'next/server';

import { isGuestUser, isOwnOrLinkedAccountId } from '@/lib/account-identity';
import { normalizeSubmittedElementDescriptors } from '@/lib/image-elements';
import {
  buildLegacyGenerationInputMedia,
  findUncapturedInputMediaTypes,
  loadGenerationInputMediaMap,
  sanitizeWorkflowSettingsForRemix,
  toRemixAssetDescriptor,
  toRemixImageElement,
  toRemixSubjects,
  type GenerationInputMediaItem,
} from '@/lib/generation-input-media';
import { REMIX_SOURCE_RATE_LIMIT, enforceBackendRateLimit } from '@/lib/backend-rate-limit';
import { isAudioModel, isImageModel, isMotionModel } from '@/lib/models';
import {
  REMIX_UNLOCK_REQUIRED_CODE,
  REMIX_UNLOCK_REQUIRED_MESSAGE,
  TEMPLATE_RESULT_REMIX_CODE,
  TEMPLATE_RESULT_REMIX_MESSAGE,
  resolveRemixAccess,
} from '@/lib/remix-access';
import {
  type RemixMediaAssetDescriptor,
  isMotionGeneration,
  motionInputDescriptors,
  normalizeRemixMediaAssetDescriptor,
  type RemixResolvedAsset,
  type RemixResolvedImageElement,
  type RemixSourceBundle,
  type RemixSourceResult,
} from '@/lib/remix-source';
import { loadGenerationRecipeRemixInputMediaByPostId } from '@/lib/post-resource-bundles-server';
import { createServiceClient, createUserClient, resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';
import {
  getUserOwnedStoredMediaLocation,
  parseCanonicalStorageObjectPath,
} from '@/lib/storage-ownership';
import type { ShowcaseItemCategory } from '@/lib/showcase';
import type { TemplateRunLink } from '@/lib/template-result';

type RemixSourceGenerationRow = TemplateRunLink & {
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
  creation_mode?: string | null;
  workflow_settings: Record<string, unknown> | null;
};

type ResultGenerationRow = Pick<
  RemixSourceGenerationRow,
  'id' | 'user_id' | 'is_public' | 'output_url' | 'showcase_asset_path'
>;

const GENERATION_SELECT =
  'id, user_id, is_public, share_input_media_for_remix, output_url, showcase_asset_path, category, creation_mode, model, prompt, title, workflow_settings, template_run_id, template_run_step_id';

// The proxy's answer to a guest on a registered-only path, word for word: the
// app already reads this code as "sign in to do that".
const GUEST_REGISTRATION_REQUIRED_MESSAGE = 'Create an account to use this feature.';
const GUEST_REGISTRATION_REQUIRED_CODE = 'REGISTRATION_REQUIRED';

export class RemixSourceError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'RemixSourceError';
    this.status = status;
    if (code) this.code = code;
  }
}

/**
 * What kind of media the source *result* is — not which tool made it. Motion
 * output is a video, so motion answers 'video' here on purpose. The tool
 * question is resolveRemixTool in remix-tools; the two look similar and are
 * not interchangeable.
 */
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
  generationId: string,
  showcaseAssetPath: string
): string | null {
  const canonicalPath = parseCanonicalStorageObjectPath(showcaseAssetPath, { minimumSegments: 3 });
  if (!canonicalPath || !canonicalPath.startsWith(`showcase/${generationId}/`)) return null;
  const { data } = adminSupabase.storage.from('showcase_media').getPublicUrl(canonicalPath);
  return data.publicUrl;
}

async function resolveGenerationResultUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generation: ResultGenerationRow
): Promise<string | null> {
  if (generation.showcase_asset_path) {
    return getShowcaseAssetUrl(
      adminSupabase,
      generation.id,
      generation.showcase_asset_path,
    );
  }

  if (!generation.output_url) {
    return null;
  }

  if (!generation.user_id) return null;
  return resolveOwnedStoredMediaUrl(
    adminSupabase,
    generation.output_url,
    generation.user_id,
  );
}

async function resolveUploadsStoragePathUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  storagePath: string,
  allowedOwnerUserId: string | null
): Promise<string | null> {
  if (!allowedOwnerUserId) {
    return null;
  }

  const location = getUserOwnedStoredMediaLocation(storagePath, allowedOwnerUserId, {
    allowedBuckets: ['uploads'],
  });
  if (!location) return null;

  const { data, error } = await adminSupabase.storage
    .from(location.bucket)
    .createSignedUrl(location.filePath, 3600);

  if (error || !data?.signedUrl) {
    logBackendError('failed_to_sign_remix_source_upload_asset', { error: error });
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
    logBackendError('failed_to_fetch_remix_referenced_generation', { error: error });
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
  } = await getVerifiedAuthUserResult(userSupabase);

  if (authError || !user) {
    throw new RemixSourceError('Unauthorized', 401);
  }

  const adminSupabase = createServiceClient();

  // Enforced here rather than in the adapter because this is the first point
  // where the caller is known. Everything below is service-role work.
  await enforceBackendRateLimit(adminSupabase, {
    ...REMIX_SOURCE_RATE_LIMIT,
    key: user.id,
  });

  const { data: generation, error } = await adminSupabase
    .from('generations')
    .select(GENERATION_SELECT)
    .eq('id', trimmedGenerationId)
    .maybeSingle();

  if (error) {
    logBackendError('failed_to_fetch_remix_source_generation', { error: error });
    throw new RemixSourceError('Failed to load remix source', 500);
  }

  const typedGeneration = generation as RemixSourceGenerationRow | null;

  // The route admits a guest (route-identity-policy.ts) so that a guest can
  // make one of its own creations again. Restoring anyone else's, a public
  // post or a bought recipe alike, is remixing it, and that takes an account
  // (POST /api/showcase/remix is registered-only). A guest is never the target
  // of a merge, so its own id is all "own or linked" holds for it; the shared
  // question is asked anyway. A generation that does not exist gets the same
  // answer, so a guest cannot tell someone's private creation from none.
  if (isGuestUser(user)) {
    const guestOwnsGeneration = typedGeneration
      ? await isOwnOrLinkedAccountId(adminSupabase, user.id, typedGeneration.user_id)
      : false;
    if (!guestOwnsGeneration) {
      throw new RemixSourceError(
        GUEST_REGISTRATION_REQUIRED_MESSAGE,
        403,
        GUEST_REGISTRATION_REQUIRED_CODE,
      );
    }
  }

  if (!typedGeneration) {
    throw new RemixSourceError('Remix source not found', 404);
  }

  // A create page reaches this loader straight from its own URL, so it must
  // apply exactly the gate POST /api/showcase/remix applies, or that gate is
  // one hop from being bypassed. Owned means the caller's id or a guest
  // identity since linked to it. Anyone else needs the generation's post to be
  // exposed right now, no block between them, and any remix-enabled recipe on
  // the post unlocked. A template's result is restored for nobody. Every
  // refusal but the unlock, and the owner's own template result, answers 404,
  // so the gate never confirms that someone else's private source exists.
  const access = await resolveRemixAccess({
    adminSupabase,
    viewerUserId: user.id,
    generation: {
      id: typedGeneration.id,
      user_id: typedGeneration.user_id,
      is_public: typedGeneration.is_public,
      share_input_media_for_remix: typedGeneration.share_input_media_for_remix ?? null,
      template_run_id: typedGeneration.template_run_id ?? null,
      template_run_step_id: typedGeneration.template_run_step_id ?? null,
    },
    requestedPostId: options?.postId ?? null,
  });
  if (!access.allowed) {
    if (access.reason === 'unlock_required') {
      throw new RemixSourceError(REMIX_UNLOCK_REQUIRED_MESSAGE, 403, REMIX_UNLOCK_REQUIRED_CODE);
    }
    if (access.reason === 'template_result') {
      throw new RemixSourceError(TEMPLATE_RESULT_REMIX_MESSAGE, 400, TEMPLATE_RESULT_REMIX_CODE);
    }
    throw new RemixSourceError('Remix source not found', 404);
  }
  const isOwner = access.basis === 'owner';

  const category = normalizeCategory(typedGeneration.category, typedGeneration.model);
  if (!category) {
    throw new RemixSourceError('This creation type does not support remix media restoration', 400);
  }

  const workflowSettings =
    typedGeneration.workflow_settings && typeof typedGeneration.workflow_settings === 'object'
      ? typedGeneration.workflow_settings
      : {};
  const isMotionWorkflow = isMotionGeneration({
    category: typedGeneration.category,
    creationMode: typedGeneration.creation_mode,
    workflowSettings,
  });
  const includeInputMedia = isOwner || access.includeSharedInputMedia;
  const effectiveWorkflowSettings = sanitizeWorkflowSettingsForRemix(workflowSettings, isOwner);
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

  // Bought recipe media is restored from the post the gate verified, never
  // from the id the caller put in the URL.
  const recipeInputMedia = !includeInputMedia && access.recipeEntitled && access.post
    ? await loadGenerationRecipeRemixInputMediaByPostId({
      postId: access.post.id,
      generationId: typedGeneration.id,
      viewerUserId: user.id,
      adminSupabase,
      })
    : [];
  const accessibleInputMedia = includeInputMedia ? inputMedia : recipeInputMedia;

  const restoreIssues: string[] = [];
  // Keeping inputs fails one item at a time, so the kept rows can hold less
  // than the recipe used. Say so: otherwise a remix restores the kept part as
  // if it were the whole recipe. Read without signing anything.
  if (includeInputMedia && hasDurableInputMedia) {
    const declaredInputMedia = await buildLegacyGenerationInputMedia({
      supabase: adminSupabase,
      generationId: typedGeneration.id,
      ownerUserId: typedGeneration.user_id,
      category: typedGeneration.category,
      workflowSettings,
      urlMode: 'none',
    });
    for (const { mediaType } of findUncapturedInputMediaTypes(declaredInputMedia, inputMedia)) {
      restoreIssues.push(`input-media-not-kept:${mediaType}`);
    }
  }
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
    // The rows themselves go to the owner only. Beside each kept copy they hold
    // the path the creator's upload was staged under and the link the run read
    // it from, both naming the file. Anyone else restores from `inputs`, which
    // is built below from the same rows and leaves those two out.
    ...(isOwner ? { inputMedia: accessibleInputMedia } : {}),
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
      const subjects = toRemixSubjects(accessibleInputMedia);
      for (const subject of subjects) {
        if (subject.images.some((image) => !image.url)) {
          restoreIssues.push(`video-subject:${subject.displayName}`);
        }
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
        subjects,
      };
    }

    if (isMotionWorkflow) {
      // The catalog path stored these under plain reference roles until motion
      // runs got motion roles, in whatever slots the model declares (production's
      // Kling 3.0: imageReferences and videoReferences). A motion run holds one
      // picture and one clip, so for those rows the kind says which is which.
      const characterImage = accessibleInputMedia.find((item) => item.role === 'character_image')
        ?? accessibleInputMedia.find((item) => item.mediaType === 'image');
      const referenceVideo = accessibleInputMedia.find((item) => item.role === 'motion_reference_video')
        ?? accessibleInputMedia.find((item) => item.mediaType === 'video');
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
        subjects: toRemixSubjects(inputMedia),
      };
    }

    if (isMotionWorkflow) {
      const motionInputs = motionInputDescriptors(workflowSettings);
      bundle.inputs.motion = {
        characterImage: await resolveAssetDescriptor(
          motionInputs.characterImage,
          'image',
          'motion-character-image'
        ),
        referenceVideo: await resolveAssetDescriptor(
          motionInputs.referenceVideo,
          'video',
          'motion-reference-video'
        ),
      };
    }
  }

  return bundle;
}
