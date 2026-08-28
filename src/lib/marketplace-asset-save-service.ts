import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  MARKETPLACE_ASSET_SAVE_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  isMarketplaceAssetStatus,
  isMarketplaceAssetType,
} from '@/lib/marketplace';
import { getCreatorPublishReadinessError } from '@/lib/marketplace-trust';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

type LinkedPostRow = {
  id: string;
  user_id: string;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
  review_status: string | null;
};

type ExistingAssetRow = {
  id: string;
  seller_user_id?: string;
};

type WorkflowCanvasRow = {
  id: string;
  user_id: string;
  graph: Partial<WorkflowCanvasGraph>;
};

export type MarketplaceAssetSaveRouteResult =
  | {
      ok: true;
      body: {
        success: true;
        assetId: string;
        postId: string | null;
        status: string;
      };
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type SaveMarketplaceAssetParams = {
  adminSupabase: SupabaseClient;
  readBody: () => Promise<unknown>;
  userId: string;
  userSupabase: SupabaseClient;
};

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredText(value: unknown, fallback: string): string {
  return normalizeOptionalText(value) ?? fallback;
}

function toPriceUsdCents(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }

  return null;
}

function createRateLimitResult(error: BackendRateLimitError): MarketplaceAssetSaveRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

function readBodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function saveMarketplaceAssetForRoute({
  adminSupabase,
  readBody,
  userId,
  userSupabase,
}: SaveMarketplaceAssetParams): Promise<MarketplaceAssetSaveRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...MARKETPLACE_ASSET_SAVE_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('marketplace_asset_save_rate_limit_check_failed', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check marketplace listing limits.' },
    };
  }

  const body = readBodyRecord(await readBody());
  const assetId = normalizeOptionalText(body.assetId);
  const postId = normalizeOptionalText(body.postId);
  const canvasId = normalizeOptionalText(body.canvasId);
  const type = typeof body.type === 'string' ? body.type : null;
  const status = typeof body.status === 'string' ? body.status : null;
  const title = normalizeOptionalText(body.title);
  const description = normalizeRequiredText(body.description, '');
  const preview = normalizeRequiredText(body.preview, description);
  const promptPack = normalizeOptionalText(body.promptPack);
  const guideMarkdown = normalizeOptionalText(body.guideMarkdown);
  const priceUsdCents = toPriceUsdCents(body.priceUsdCents);

  if (!isMarketplaceAssetType(type)) {
    return { ok: false, status: 400, body: { error: 'Invalid asset type.' } };
  }

  if (!isMarketplaceAssetStatus(status)) {
    return { ok: false, status: 400, body: { error: 'Invalid listing status.' } };
  }

  if (!title) {
    return { ok: false, status: 400, body: { error: 'Title is required.' } };
  }

  if (priceUsdCents === null || priceUsdCents < 0 || (priceUsdCents > 0 && priceUsdCents < 100)) {
    return { ok: false, status: 400, body: { error: 'Price must be free or at least $1.00.' } };
  }

  if (status === 'active' || status === 'unlisted') {
    const { data: sellerProfile, error: sellerProfileError } = await userSupabase
      .from('profiles')
      .select('username, display_name, avatar_url')
      .eq('id', userId)
      .maybeSingle();

    if (sellerProfileError) {
      logBackendError('failed_to_verify_marketplace_seller_profile', { error: sellerProfileError });
      return { ok: false, status: 500, body: { error: 'Could not verify your creator profile right now. Try again.' } };
    }

    const profileError = getCreatorPublishReadinessError({
      username: typeof sellerProfile?.username === 'string' ? sellerProfile.username : null,
      displayName: typeof sellerProfile?.display_name === 'string' ? sellerProfile.display_name : null,
      avatarUrl: typeof sellerProfile?.avatar_url === 'string' ? sellerProfile.avatar_url : null,
    });

    if (profileError) {
      return {
        ok: false,
        status: 400,
        body: {
          error: profileError,
          field: 'profile',
          actionHref: '/profile',
          actionLabel: 'Complete profile and return',
        },
      };
    }
  }

  if (postId) {
    const { data: linkedPost, error: linkedPostError } = await adminSupabase
      .from('posts')
      .select('id, user_id, visibility, archived_at, review_status')
      .eq('id', postId)
      .eq('user_id', userId)
      .maybeSingle();

    const typedLinkedPost = (linkedPost as LinkedPostRow | null) ?? null;

    if (linkedPostError || !typedLinkedPost || typedLinkedPost.user_id !== userId) {
      return { ok: false, status: 400, body: { error: 'You can only attach listings to your own posts.' } };
    }

    if (
      status === 'active'
      && (
        typedLinkedPost.visibility !== 'public'
        || typedLinkedPost.archived_at !== null
        || typedLinkedPost.review_status !== 'visible'
      )
    ) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'Active listings can only attach to public posts. Publish the post first or save this listing as draft/unlisted.',
        },
      };
    }

    const { data: existingPostAsset, error: existingPostAssetError } = await userSupabase
      .from('marketplace_assets')
      .select('id')
      .eq('post_id', postId)
      .maybeSingle();

    if (existingPostAssetError) {
      logBackendError('failed_to_check_existing_post_asset', { error: existingPostAssetError });
      return { ok: false, status: 500, body: { error: 'Failed to validate linked post.' } };
    }

    if (existingPostAsset && (existingPostAsset as ExistingAssetRow).id !== assetId) {
      return { ok: false, status: 409, body: { error: 'This post already has a linked marketplace listing.' } };
    }
  }

  let workflowGraph: ReturnType<typeof serializeWorkflowGraph> | null = null;
  if (type === 'workflow') {
    if (!canvasId) {
      return { ok: false, status: 400, body: { error: 'Select a workflow canvas to list.' } };
    }

    const { data: canvas, error: canvasError } = await userSupabase
      .from('workflow_canvases')
      .select('id, user_id, graph')
      .eq('id', canvasId)
      .maybeSingle();

    const typedCanvas = (canvas as WorkflowCanvasRow | null) ?? null;
    if (canvasError || !typedCanvas || typedCanvas.user_id !== userId) {
      return { ok: false, status: 404, body: { error: 'Workflow canvas not found.' } };
    }

    workflowGraph = serializeWorkflowGraph(normalizeWorkflowGraph(typedCanvas.graph));
  }

  if (type === 'prompt_pack' && !promptPack) {
    return { ok: false, status: 400, body: { error: 'Prompt pack content is required.' } };
  }

  if (type === 'guide' && !guideMarkdown) {
    return { ok: false, status: 400, body: { error: 'Guide content is required.' } };
  }

  if (assetId) {
    const { data: existingAsset, error: assetError } = await userSupabase
      .from('marketplace_assets')
      .select('id, seller_user_id')
      .eq('id', assetId)
      .maybeSingle();

    const typedExistingAsset = (existingAsset as ExistingAssetRow | null) ?? null;
    if (assetError || !typedExistingAsset || typedExistingAsset.seller_user_id !== userId) {
      return { ok: false, status: 404, body: { error: 'Listing not found.' } };
    }
  }

  const { data: asset, error: assetUpsertError } = await userSupabase
    .from('marketplace_assets')
    .upsert({
      id: assetId ?? undefined,
      seller_user_id: userId,
      post_id: postId,
      type,
      title,
      description,
      preview,
      price_usd_cents: priceUsdCents,
      status,
    })
    .select('id, post_id, status')
    .single();

  if (assetUpsertError || !asset) {
    logBackendError('failed_to_upsert_marketplace_asset', { error: assetUpsertError });
    return { ok: false, status: 500, body: { error: 'Failed to save listing.' } };
  }

  const { error: contentError } = await userSupabase
    .from('marketplace_asset_content')
    .upsert({
      asset_id: asset.id,
      workflow_graph: type === 'workflow' ? workflowGraph : null,
      prompt_pack: type === 'prompt_pack' ? promptPack : null,
      guide_markdown: type === 'guide' ? guideMarkdown : null,
    });

  if (contentError) {
    logBackendError('failed_to_upsert_marketplace_asset_content', { error: contentError });
    return { ok: false, status: 500, body: { error: 'Failed to save listing content.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      assetId: asset.id,
      postId: asset.post_id,
      status: asset.status,
    },
  };
}
