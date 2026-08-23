import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ensureDurableGenerationMedia,
  type CreatedGenerationMediaLocation,
} from '@/lib/durable-generation-media';
import { isAudioModel } from '@/lib/models';
import {
  buildGenerationReferenceResourceItems,
  getMarketplaceQualityErrorForPostBundle,
  mergeGenerationReferenceItemsIntoBundle,
  publishGenerationPostWithResourceBundleAtomically,
} from '@/lib/post-resource-bundles-server';
import {
  deriveTitleFromBody,
  isMissingPostsSchemaError,
  isMissingPostResourceBundlesSchemaError,
} from '@/lib/posts-server';
import { listSourceToolsCatalog } from '@/lib/source-tools-server';
import { normalizeSourceToolInputWithCatalog } from '@/lib/source-tools';
import { MAGICBOOKLET_SOURCE_KIND } from '@/lib/showcase';
import {
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';
import { openAllowlistedRemoteMedia } from '@/lib/remote-media-security';
import {
  createGenerationShowcaseDerivative,
  getCanonicalGenerationShowcaseAssetPath,
  normalizeGenerationShowcaseCategory,
  SHOWCASE_MEDIA_BUCKET,
  type GenerationShowcaseCategory,
} from '@/lib/generation-post-media';
import {
  validatePostResourceBundleInput,
  type PostResourceBundleInput,
} from '@/lib/post-resource-bundles';
import {
  isCreatorProfileCheckError,
  isCreatorProfileReadinessError,
} from '@/lib/marketplace-trust';
import { sanitizePublicPostContent } from '@/lib/post-public-content';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import {
  getPublicUgcSafetyViolation,
  PUBLIC_UGC_SAFETY_ERROR,
} from '@/lib/public-ugc-safety';

type ShowcaseCategory = GenerationShowcaseCategory;

// Tests and the route adapter import this from here.
export { getCanonicalGenerationShowcaseAssetPath };
const MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR =
  'Posts are working, but atomic unlock publishing is not enabled on the connected Supabase project yet. Apply the post resource bundle migrations, including 20260508120000_post_system_marketplace_reliability.sql, and try again.';
const GENERATION_SELECT_WITH_SHOWCASE_ASSET = 'id, user_id, status, model, category, creation_mode, output_url, showcase_asset_path, title, description, prompt, template_run_id, template_run_step_id';
// The legacy variant serves schemas that predate `showcase_asset_path`, which
// also predate the template system — so it omits the template columns too and
// such rows publish as ordinary generations.
const GENERATION_SELECT_WITHOUT_SHOWCASE_ASSET = 'id, user_id, status, model, category, output_url, title, description, prompt';

type GenerationRow = {
  id: string;
  user_id: string;
  status: string;
  model: string;
  category: string | null;
  creation_mode?: string | null;
  output_url: string | null;
  showcase_asset_path?: string | null;
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  template_run_id?: string | null;
  template_run_step_id?: string | null;
};

type StoredGenerationBundleRow = {
  access_mode: 'none' | 'free' | 'paid';
  sales_count: number | null;
  summary: string | null;
  preview_text: string | null;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: unknown;
  attachments: unknown;
  allow_remix: boolean | null;
  price_usd_cents: number | null;
  resource_sections: unknown;
  resource_items: unknown;
};

export type ShowcasePublishRequestBody = {
  generationId: string;
  isPublic?: boolean;
  visibility?: 'public' | 'unlisted' | 'private';
  title?: string;
  description?: string;
  prompt?: string;
  body?: string;
  category?: string;
  workflowSettings?: unknown;
  exposePromptPublic?: boolean;
  shareInputMediaForRemix?: boolean;
  includeGenerationReferences?: boolean;
  resourceBundle?: PostResourceBundleInput | null;
};

export type ShowcasePublishServiceDependencies = {
  ensureDurableGenerationMedia: typeof ensureDurableGenerationMedia;
  fetchWithProviderTimeout: typeof fetchWithProviderTimeout;
  openAllowlistedRemoteMedia: typeof openAllowlistedRemoteMedia;
  buildGenerationReferenceResourceItems: typeof buildGenerationReferenceResourceItems;
  mergeGenerationReferenceItemsIntoBundle: typeof mergeGenerationReferenceItemsIntoBundle;
  validatePostResourceBundleInput: typeof validatePostResourceBundleInput;
  getMarketplaceQualityErrorForPostBundle: typeof getMarketplaceQualityErrorForPostBundle;
  publishGenerationPostWithResourceBundleAtomically: typeof publishGenerationPostWithResourceBundleAtomically;
  deriveTitleFromBody: typeof deriveTitleFromBody;
  isMissingPostsSchemaError: typeof isMissingPostsSchemaError;
  isMissingPostResourceBundlesSchemaError: typeof isMissingPostResourceBundlesSchemaError;
  listSourceToolsCatalog: typeof listSourceToolsCatalog;
  loadFrozenSoldGenerationBundleForQuality: typeof loadFrozenSoldGenerationBundleForQuality;
  loadExistingGenerationPostContent: typeof loadExistingGenerationPostContent;
};

export type ShowcasePublishServiceResult =
  | {
      ok: true;
      body: {
        success: true;
        isPublic: boolean;
        visibility: 'public' | 'unlisted' | 'private';
        postId: string | null;
        showcasePath: string | null;
        ownerPath: string | null;
        resourceBundlePath: string | null;
        resourceBundleStatus: 'draft' | 'published' | null;
        message: string;
      };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 500;
      body: {
        error: string;
        field?: string;
        code?: string;
        actionHref?: string;
        actionLabel?: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<ShowcasePublishServiceDependencies> | undefined,
): ShowcasePublishServiceDependencies {
  return {
    ensureDurableGenerationMedia: dependencies?.ensureDurableGenerationMedia ?? ensureDurableGenerationMedia,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchWithProviderTimeout,
    openAllowlistedRemoteMedia:
      dependencies?.openAllowlistedRemoteMedia ?? openAllowlistedRemoteMedia,
    buildGenerationReferenceResourceItems:
      dependencies?.buildGenerationReferenceResourceItems ?? buildGenerationReferenceResourceItems,
    mergeGenerationReferenceItemsIntoBundle:
      dependencies?.mergeGenerationReferenceItemsIntoBundle ?? mergeGenerationReferenceItemsIntoBundle,
    validatePostResourceBundleInput: dependencies?.validatePostResourceBundleInput ?? validatePostResourceBundleInput,
    getMarketplaceQualityErrorForPostBundle:
      dependencies?.getMarketplaceQualityErrorForPostBundle ?? getMarketplaceQualityErrorForPostBundle,
    publishGenerationPostWithResourceBundleAtomically:
      dependencies?.publishGenerationPostWithResourceBundleAtomically ?? publishGenerationPostWithResourceBundleAtomically,
    deriveTitleFromBody: dependencies?.deriveTitleFromBody ?? deriveTitleFromBody,
    isMissingPostsSchemaError: dependencies?.isMissingPostsSchemaError ?? isMissingPostsSchemaError,
    isMissingPostResourceBundlesSchemaError:
      dependencies?.isMissingPostResourceBundlesSchemaError ?? isMissingPostResourceBundlesSchemaError,
    listSourceToolsCatalog: dependencies?.listSourceToolsCatalog ?? listSourceToolsCatalog,
    loadFrozenSoldGenerationBundleForQuality:
      dependencies?.loadFrozenSoldGenerationBundleForQuality ?? loadFrozenSoldGenerationBundleForQuality,
    loadExistingGenerationPostContent:
      dependencies?.loadExistingGenerationPostContent ?? loadExistingGenerationPostContent,
  };
}

function detectCategoryFromModel(model: string): ShowcaseCategory {
  if (model.includes('banana')) return 'image';
  if (model === 'kling-3.0/video' || model.includes('/video')) return 'video';
  if (model.startsWith('kling-')) return 'video';
  return 'image';
}

function normalizeTextValue(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function normalizeRequestedVisibility(value: unknown, legacyIsPublic?: boolean): 'public' | 'unlisted' | 'private' {
  if (value === 'public' || value === 'unlisted' || value === 'private') {
    return value;
  }

  return legacyIsPublic ? 'public' : 'private';
}

function isSoldResourceBundleMutationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [candidate.message, candidate.details, candidate.hint].some((value) => (
    typeof value === 'string' && /RESOURCE_BUNDLE_LOCKED|already been purchased/i.test(value)
  ));
}

async function loadOwnedGeneration({
  generationId,
  supabase,
}: {
  generationId: string;
  supabase: SupabaseClient;
}): Promise<{
  generation: GenerationRow | null;
  error: unknown;
  hasShowcaseAssetColumn: boolean;
}> {
  let generationQuery = await supabase
    .from('generations')
    .select(GENERATION_SELECT_WITH_SHOWCASE_ASSET)
    .eq('id', generationId)
    .single();

  let hasShowcaseAssetColumn = true;
  if (generationQuery.error?.code === '42703') {
    hasShowcaseAssetColumn = false;
    generationQuery = await supabase
      .from('generations')
      .select(GENERATION_SELECT_WITHOUT_SHOWCASE_ASSET)
      .eq('id', generationId)
      .single();
  }

  return {
    generation: generationQuery.data as GenerationRow | null,
    error: generationQuery.error,
    hasShowcaseAssetColumn,
  };
}

async function loadFrozenSoldGenerationBundleForQuality({
  generationId,
  ownerUserId,
  supabase,
}: {
  generationId: string;
  ownerUserId: string;
  supabase: SupabaseClient;
}): Promise<PostResourceBundleInput | null> {
  const { data: post, error: postError } = await supabase
    .from('posts')
    .select('id')
    .eq('generation_id', generationId)
    .eq('user_id', ownerUserId)
    .maybeSingle();
  if (postError) {
    throw postError;
  }
  if (!post || typeof post.id !== 'string') {
    return null;
  }

  const { data, error } = await supabase
    .from('post_resource_bundles')
    .select(
      'access_mode, sales_count, summary, preview_text, prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix, price_usd_cents, resource_sections, resource_items',
    )
    .eq('post_id', post.id)
    .eq('owner_user_id', ownerUserId)
    .maybeSingle();
  if (error) {
    throw error;
  }

  const bundle = data as StoredGenerationBundleRow | null;
  if (!bundle || (bundle.sales_count ?? 0) <= 0 || bundle.access_mode === 'none') {
    return null;
  }

  return {
    accessMode: bundle.access_mode,
    summary: bundle.summary,
    previewText: bundle.preview_text,
    priceUsdCents: bundle.price_usd_cents,
    resources: {
      promptText: bundle.prompt_text,
      notesMarkdown: bundle.notes_markdown,
      workflowShareUrl: bundle.workflow_share_url,
      workflowSnapshot: bundle.workflow_snapshot ?? null,
      attachments: Array.isArray(bundle.attachments) ? bundle.attachments : [],
      allowRemix: bundle.allow_remix === true,
      sections: Array.isArray(bundle.resource_sections) ? bundle.resource_sections : [],
      items: Array.isArray(bundle.resource_items) ? bundle.resource_items : [],
    } as NonNullable<PostResourceBundleInput['resources']>,
  };
}

type ExistingGenerationPostContent = {
  title: string | null;
  description: string | null;
  prompt: string | null;
  body: string | null;
  category: string | null;
};

/**
 * The content a visibility-only request must carry forward. The post row is
 * written with upsert semantics, so every column this caller does not supply
 * would otherwise be rebuilt from the generation — and the generation never
 * saw the caption, body, or title edits made in the post editor.
 */
async function loadExistingGenerationPostContent({
  generationId,
  ownerUserId,
  supabase,
}: {
  generationId: string;
  ownerUserId: string;
  supabase: SupabaseClient;
}): Promise<ExistingGenerationPostContent | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('title, description, prompt, body, category')
    .eq('generation_id', generationId)
    .eq('user_id', ownerUserId)
    .maybeSingle();
  if (error) {
    throw error;
  }

  return (data as ExistingGenerationPostContent | null) ?? null;
}

/**
 * Whether the generation is the canonical deliverable of the viewer's own
 * successful, non-test template run. Anything else that is template-linked —
 * intermediate step outputs, creator test runs, someone else's run — is
 * backend-private and must not be publishable at all.
 */
async function hasCanonicalConsumerRun({
  adminSupabase,
  generationId,
  userId,
}: {
  adminSupabase: SupabaseClient;
  generationId: string;
  userId: string;
}): Promise<boolean> {
  const { data: canonicalRun, error: canonicalRunError } = await adminSupabase
    .from('template_runs')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'succeeded')
    .eq('is_test', false)
    .eq('result_generation_id', generationId)
    .maybeSingle();

  if (canonicalRunError) {
    logBackendError('failed_to_check_canonical_template_run_for_publish', { error: canonicalRunError });
    return false;
  }

  return Boolean(canonicalRun);
}

export async function publishGenerationToShowcaseForRoute({
  adminSupabase,
  body: requestBody,
  dependencies,
  userId,
}: {
  adminSupabase: SupabaseClient;
  body: ShowcasePublishRequestBody;
  dependencies?: Partial<ShowcasePublishServiceDependencies>;
  userId: string;
}): Promise<ShowcasePublishServiceResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const {
    generationId,
    isPublic,
    title,
    description,
    prompt: requestedPrompt,
    body,
    category,
    workflowSettings: requestedWorkflowSettings,
  } = requestBody;

  // Read with the service client on purpose. The authenticated Data API
  // surface for `generations` is deliberately column-scoped
  // (20260726071722_harden_data_api_and_storage_contract.sql), so a
  // user-scoped read of the publish columns (prompt, output_url, title, …) is
  // rejected outright — the viewer's own creation would report "not found".
  // Authorization is the explicit ownership check below, the same boundary
  // the template path has always used.
  const generationResult = await loadOwnedGeneration({
    generationId,
    supabase: adminSupabase,
  });

  if (generationResult.error && !generationResult.generation) {
    logBackendError('failed_to_load_generation_for_publish', { error: generationResult.error });
  }

  const generation = generationResult.generation;
  const hasShowcaseAssetColumn = generationResult.hasShowcaseAssetColumn;

  if (!generation) {
    return { ok: false, status: 404, body: { error: 'Generation not found' } };
  }

  // A template-linked generation is backend-private: only the canonical
  // deliverable of the viewer's own successful consumer run may publish, and
  // every other outcome reports plain "not found" rather than disclosing
  // anything about the row (matching the row-level invisibility these
  // generations had under 20260711154500_private_template_generations.sql).
  const isTemplateLinked = Boolean(generation.template_run_id || generation.template_run_step_id);
  let isCanonicalTemplateResult = false;

  if (isTemplateLinked) {
    isCanonicalTemplateResult = generation.user_id === userId
      && generation.status === 'succeeded'
      && await hasCanonicalConsumerRun({ adminSupabase, generationId, userId });

    if (!isCanonicalTemplateResult) {
      return { ok: false, status: 404, body: { error: 'Generation not found' } };
    }
  }

  if (generation.user_id !== userId) {
    return { ok: false, status: 403, body: { error: 'Unauthorized: You do not own this creation' } };
  }

  if (generation.status !== 'succeeded') {
    return { ok: false, status: 400, body: { error: 'Cannot publish a generation that has not succeeded' } };
  }

  if (
    isCanonicalTemplateResult
    && (
      requestBody.exposePromptPublic === true
      || requestBody.shareInputMediaForRemix === true
      || requestBody.includeGenerationReferences === true
      || (requestBody.resourceBundle?.accessMode !== undefined && requestBody.resourceBundle.accessMode !== 'none')
    )
  ) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Template results can publish media and a caption, but cannot share the private recipe or input files.' },
    };
  }

  const requestedVisibility = normalizeRequestedVisibility(requestBody.visibility, isPublic);
  const prompt = isCanonicalTemplateResult ? undefined : requestedPrompt;
  const workflowSettings = isCanonicalTemplateResult ? undefined : requestedWorkflowSettings;
  const effectiveVisibility = requestedVisibility;
  const shouldExposePost = effectiveVisibility !== 'private';
  const effectiveIsPublic = effectiveVisibility === 'public';
  const effectiveShareInputMediaForRemix = effectiveIsPublic && requestBody.shareInputMediaForRemix === true;
  const hasRequestedResourceBundlePayload = !isCanonicalTemplateResult
    && Object.prototype.hasOwnProperty.call(requestBody, 'resourceBundle');
  const requestedResourceBundle = isCanonicalTemplateResult ? null : requestBody.resourceBundle ?? null;
  const requestedAccessMode = requestedResourceBundle?.accessMode ?? 'none';
  const shouldIncludeGenerationReferences = requestBody.includeGenerationReferences === true;
  let effectiveResourceBundle: PostResourceBundleInput | null = requestedResourceBundle;
  let effectiveHasResourceBundlePayload = hasRequestedResourceBundlePayload;

  if (
    shouldIncludeGenerationReferences &&
    requestedAccessMode !== 'none'
  ) {
    const referenceItems = await resolvedDependencies.buildGenerationReferenceResourceItems({
      supabase: adminSupabase,
      ownerUserId: userId,
      generationId,
    });

    if (referenceItems.length > 0) {
      if (effectiveResourceBundle) {
        effectiveResourceBundle = resolvedDependencies.mergeGenerationReferenceItemsIntoBundle(
          effectiveResourceBundle,
          referenceItems,
        );
        effectiveHasResourceBundlePayload = true;
      }
    }
  }

  const resourceBundleValidationError = effectiveHasResourceBundlePayload
    ? resolvedDependencies.validatePostResourceBundleInput(effectiveResourceBundle ?? null, {
        ownerUserId: userId,
        mediaKeys: ['media-1'],
      })
    : null;
  if (resourceBundleValidationError) {
    return { ok: false, status: 400, body: { error: resourceBundleValidationError } };
  }
  let frozenSoldBundleForRepublish: PostResourceBundleInput | null = null;
  if (effectiveVisibility === 'public' && !effectiveHasResourceBundlePayload && !isCanonicalTemplateResult) {
    try {
      frozenSoldBundleForRepublish = await resolvedDependencies.loadFrozenSoldGenerationBundleForQuality({
        generationId,
        ownerUserId: userId,
        supabase: adminSupabase,
      });
    } catch (error) {
      logBackendError('failed_to_load_frozen_generation_bundle_for_republish', { error });
      return {
        ok: false,
        status: 500,
        body: { error: 'Could not verify the existing package before publishing. Try again.' },
      };
    }
  }
  const bundleForPublicValidation = effectiveHasResourceBundlePayload
    ? effectiveResourceBundle
    : frozenSoldBundleForRepublish;
  const shouldExposePromptPublic = requestBody.exposePromptPublic === true && !bundleForPublicValidation;

  if (shouldExposePost && (generation.category === 'audio' || isAudioModel(generation.model))) {
    return { ok: false, status: 400, body: { error: 'Audio generations are not publishable to the showcase yet' } };
  }

  // This endpoint serves two very different callers. Studio flips an existing
  // post's visibility with nothing but { generationId, visibility }, and that
  // must keep working — it is not composing anything. A request that carries
  // post content is a compose submission, and those have to name the post.
  const isComposeSubmission =
    title !== undefined
    || description !== undefined
    || body !== undefined
    || category !== undefined
    || requestBody.resourceBundle !== undefined;

  // A visibility-only request is written through the same upsert as a compose
  // submission, so its post content has to come from the stored post rather
  // than be rebuilt from the generation. The generation never received the
  // body or the edits made while the post was private; falling back to it
  // silently erased them. Refusing the flip beats wiping the caption.
  let existingPost: ExistingGenerationPostContent | null = null;
  if (!isComposeSubmission) {
    try {
      existingPost = await resolvedDependencies.loadExistingGenerationPostContent({
        generationId,
        ownerUserId: userId,
        supabase: adminSupabase,
      });
    } catch (error) {
      logBackendError('failed_to_load_existing_post_for_visibility_change', { error });
      return {
        ok: false,
        status: 500,
        body: { error: 'Could not load the existing post before changing its visibility. Try again.' },
      };
    }
  }

  let detectedCategory = normalizeGenerationShowcaseCategory(category)
    ?? normalizeGenerationShowcaseCategory(existingPost?.category)
    ?? normalizeGenerationShowcaseCategory(generation.category);
  if (!detectedCategory && shouldExposePost) {
    detectedCategory = detectCategoryFromModel(generation.model);
  }

  const normalizedBody = normalizeTextValue(body) ?? normalizeTextValue(existingPost?.body);
  const hasRecipe = Boolean(bundleForPublicValidation && bundleForPublicValidation.accessMode !== 'none');
  const isPaidRecipe = bundleForPublicValidation?.accessMode === 'paid';
  const requestedDescription = normalizeTextValue(description);
  const descriptionCandidate = requestedDescription
    ?? normalizeTextValue(existingPost?.description)
    ?? (isPaidRecipe ? null : generation.description?.trim() ?? null);
  const sanitizedPublicContent = sanitizePublicPostContent({
    body: normalizedBody ?? '',
    description: descriptionCandidate ?? '',
    hasRecipe,
    isPaidRecipe,
    prompt: normalizeTextValue(prompt) ?? generation.prompt?.trim() ?? '',
  });
  const resolvedTitle =
    normalizeTextValue(title)
    ?? normalizeTextValue(existingPost?.title)
    ?? generation.title?.trim()
    ?? resolvedDependencies.deriveTitleFromBody(sanitizedPublicContent.body || null)
    ?? null;

  if (isComposeSubmission && !resolvedTitle) {
    return { ok: false, status: 400, body: { error: 'Add a title for your post.', field: 'title' } };
  }

  const safetyViolation = shouldExposePost
    ? getPublicUgcSafetyViolation({
        title: resolvedTitle,
        description: descriptionCandidate,
        body: normalizedBody,
        // Inspect the originating prompt even when a recipe or privacy choice
        // keeps it out of the public post payload.
        prompt: normalizeTextValue(prompt) ?? generation.prompt?.trim() ?? null,
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

  const marketplaceQualityError = effectiveVisibility === 'public'
    ? await resolvedDependencies.getMarketplaceQualityErrorForPostBundle({
        supabase: adminSupabase,
        ownerUserId: userId,
        post: {
          title: resolvedTitle,
          body: normalizedBody,
          visibility: effectiveVisibility,
          archivedAt: null,
          reviewStatus: 'visible',
          outputUrl: generation.output_url,
          hasMedia: Boolean(generation.output_url),
        },
        bundle: bundleForPublicValidation,
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

  const updatePayload: { is_public: boolean; [key: string]: unknown } = {
    is_public: effectiveIsPublic,
    share_input_media_for_remix: effectiveShareInputMediaForRemix,
  };

  let nextShowcaseAssetPath = hasShowcaseAssetColumn ? generation.showcase_asset_path ?? null : null;
  let nextOutputUrl = generation.output_url;
  let createdPrivateMediaLocation: CreatedGenerationMediaLocation | null = null;

  if (shouldExposePost) {
    if (!generation.output_url) {
      return { ok: false, status: 400, body: { error: 'This creation has no media to publish yet' } };
    }

    if (hasShowcaseAssetColumn) {
      nextShowcaseAssetPath = await createGenerationShowcaseDerivative({
        adminSupabase,
        generationId,
        ownerUserId: userId,
        outputUrl: generation.output_url,
        category: detectedCategory ?? 'image',
        openRemoteMedia: resolvedDependencies.openAllowlistedRemoteMedia,
      });
      updatePayload.showcase_asset_path = nextShowcaseAssetPath;
    }

    if (title !== undefined) updatePayload.title = title;
    if (description !== undefined) updatePayload.description = description;
    if (prompt !== undefined) updatePayload.prompt = prompt;
    if (detectedCategory !== undefined) updatePayload.category = detectedCategory;
    if (workflowSettings !== undefined) updatePayload.workflow_settings = workflowSettings;
  } else {
    if (generation.output_url || generation.showcase_asset_path) {
      try {
        const durableMedia = await resolvedDependencies.ensureDurableGenerationMedia({
          supabase: adminSupabase,
          generation: {
            id: generation.id,
            userId: generation.user_id,
            model: generation.model,
            category: generation.category,
            outputUrl: generation.output_url,
            showcaseAssetPath: hasShowcaseAssetColumn ? generation.showcase_asset_path ?? null : null,
          },
        });
        nextOutputUrl = durableMedia.outputUrl;
        createdPrivateMediaLocation = durableMedia.createdLocation;
        if (nextOutputUrl !== generation.output_url) {
          updatePayload.output_url = nextOutputUrl;
        }
      } catch (mediaError) {
        logBackendError('failed_to_secure_private_generation_media', { error: mediaError });
        return {
          ok: false,
          status: 500,
          body: {
            error: 'This post could not be made private because its preview could not be secured. The current visibility was kept.',
          },
        };
      }
    }

    if (hasShowcaseAssetColumn) {
      updatePayload.showcase_asset_path = null;
      nextShowcaseAssetPath = null;
    }
  }

  let postId: string | null = null;
  let resourceBundleStatus: 'draft' | 'published' | null = null;
  const sourceToolCatalog = await resolvedDependencies.listSourceToolsCatalog();
  const normalizedAppSourceTool = normalizeSourceToolInputWithCatalog(sourceToolCatalog, {
    slug: 'magicbooklet',
  });
  const postPayload = {
    user_id: generation.user_id,
    visibility: effectiveVisibility,
    category: detectedCategory ?? 'image',
    title: resolvedTitle,
    description: sanitizedPublicContent.description || null,
    prompt: shouldExposePromptPublic
      ? normalizeTextValue(prompt) ?? generation.prompt?.trim() ?? null
      : isComposeSubmission
        ? null
        : normalizeTextValue(existingPost?.prompt) || null,
    body: sanitizedPublicContent.body || null,
    post_format: sanitizedPublicContent.body ? 'mixed' : 'media',
    source_kind: MAGICBOOKLET_SOURCE_KIND,
    source_tool: normalizedAppSourceTool.label ?? 'magicbooklet',
    source_tool_slug: normalizedAppSourceTool.slug ?? 'magicbooklet',
    generation_id: generation.id,
    creation_mode: generation.creation_mode ?? (generation.category === 'motion' ? 'motion' : null),
    showcase_asset_path: nextShowcaseAssetPath,
    output_url: nextOutputUrl,
  };

  try {
    const publishResult = await resolvedDependencies.publishGenerationPostWithResourceBundleAtomically({
      supabase: adminSupabase,
      generationId,
      ownerUserId: userId,
      generationUpdate: updatePayload,
      post: postPayload,
      bundle: effectiveResourceBundle,
      hasBundlePayload: effectiveHasResourceBundlePayload,
    });
    postId = publishResult.postId;
    resourceBundleStatus = publishResult.bundleStatus;
  } catch (postError) {
    if (hasShowcaseAssetColumn && nextShowcaseAssetPath && nextShowcaseAssetPath !== generation.showcase_asset_path) {
      const removableDerivativePath = getCanonicalGenerationShowcaseAssetPath(
        nextShowcaseAssetPath,
        generation.id,
      );
      if (removableDerivativePath) {
        void adminSupabase.storage
          .from(SHOWCASE_MEDIA_BUCKET)
          .remove([removableDerivativePath])
          .catch((storageError) => {
            logBackendError('failed_to_delete_showcase_derivative_after_publish_failure', { error: storageError });
          });
      }
    }

    if (createdPrivateMediaLocation) {
      const cleanupResult = await adminSupabase.storage
        .from(createdPrivateMediaLocation.bucket)
        .remove([createdPrivateMediaLocation.filePath]);
      if (cleanupResult.error) {
        logBackendError('failed_to_delete_private_generation_media_after_publish_failure', { error: cleanupResult.error });
      }
    }

    // The database performs this check while holding the bundle row lock, so a
    // checkout racing this request cannot be bypassed by the generation route.
    // In particular, an old composer that submits `{ accessMode: 'none' }`
    // receives a conflict instead of silently delisting a sold package.
    if (isSoldResourceBundleMutationError(postError)) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'People have already purchased this package, so its contents, price, and access mode are locked.',
          code: 'RESOURCE_BUNDLE_LOCKED',
        },
      };
    }

    if (resolvedDependencies.isMissingPostsSchemaError(postError)) {
      return { ok: false, status: 500, body: { error: 'Failed to sync showcase post' } };
    }

    logBackendError('failed_to_sync_generation_post', { error: postError });
    if (resolvedDependencies.isMissingPostResourceBundlesSchemaError(postError)) {
      return { ok: false, status: 500, body: { error: MISSING_POST_RESOURCE_BUNDLES_SCHEMA_ERROR } };
    }
    return { ok: false, status: 500, body: { error: 'Failed to sync showcase post' } };
  }

  invalidateShowcaseFeedCache();

  if (effectiveVisibility === 'private' && hasShowcaseAssetColumn && generation.showcase_asset_path) {
    const removableShowcasePath = getCanonicalGenerationShowcaseAssetPath(
      generation.showcase_asset_path,
      generation.id,
    );
    if (removableShowcasePath) {
      const removalResult = await adminSupabase.storage
        .from(SHOWCASE_MEDIA_BUCKET)
        .remove([removableShowcasePath]);
      if (removalResult.error) {
        logBackendError('failed_to_delete_showcase_derivative_after_unpublish', { error: removalResult.error });
      }
    }
  }

  return {
    ok: true,
    body: {
      success: true,
      isPublic: effectiveIsPublic,
      visibility: effectiveVisibility,
      postId,
      showcasePath: postId && effectiveVisibility !== 'private' ? `/showcase/${postId}` : null,
      ownerPath: postId ? `/post/${postId}/edit` : null,
      resourceBundlePath: postId
        ? resourceBundleStatus === 'draft' || effectiveVisibility === 'private'
          ? `/post/${postId}/edit#recipe`
          : `/showcase/${postId}#recipe`
        : null,
      resourceBundleStatus,
      message:
        effectiveVisibility === 'public'
          ? 'Successfully published to showcase'
          : effectiveVisibility === 'unlisted'
            ? 'Saved as an unlisted post'
            : 'Saved as a private post',
    },
  };
}
