import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  MARKETPLACE_ASSET_IMPORT_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';

type MarketplaceWorkflowAssetRow = {
  id: string;
  seller_user_id: string;
  type: string;
  title: string | null;
};

type MarketplaceAssetContentRow = {
  workflow_graph?: Partial<WorkflowCanvasGraph> | null;
};

type WorkflowCanvasImportRow = {
  id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph>;
  revision: number;
  created_at: string;
  updated_at: string;
  status?: 'draft' | 'published';
  published_at?: string | null;
};

export type MarketplaceAssetImportResult =
  | {
    ok: true;
    body: {
      success: true;
      redirectTo: '/create-workflow';
      canvas: ReturnType<typeof withWorkflowCanvasLifecycleDefaults<WorkflowCanvasImportRow>>;
    };
  }
  | {
    ok: false;
    status: 400 | 403 | 404 | 429 | 500;
    body: Record<string, unknown>;
    code?: string;
    retryAfterSeconds?: number;
    limit?: number;
    remaining?: number;
    resetAt?: string;
  };

type ImportMarketplaceWorkflowAssetParams = {
  adminSupabase: SupabaseClient;
  assetId: string;
  userId: string;
  userSupabase: SupabaseClient;
};

function createRateLimitResult(error: BackendRateLimitError): MarketplaceAssetImportResult {
  return {
    ok: false,
    status: 429,
    code: 'RATE_LIMITED',
    retryAfterSeconds: error.retryAfterSeconds,
    limit: error.state.limit,
    remaining: error.state.remaining,
    resetAt: error.state.resetAt,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

function safeWorkflowTitle(value: unknown) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : 'Untitled workflow';
}

export async function importMarketplaceWorkflowAssetForRoute({
  adminSupabase,
  assetId,
  userId,
  userSupabase,
}: ImportMarketplaceWorkflowAssetParams): Promise<MarketplaceAssetImportResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...MARKETPLACE_ASSET_IMPORT_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('marketplace_asset_import_rate_limit_check_failed', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check marketplace import limits.' },
    };
  }

  const { data: asset, error: assetError } = await adminSupabase
    .from('marketplace_assets')
    .select('id, seller_user_id, type, title')
    .eq('id', assetId)
    .maybeSingle();

  if (assetError || !asset) {
    return { ok: false, status: 404, body: { error: 'Workflow listing not found.' } };
  }

  const typedAsset = asset as MarketplaceWorkflowAssetRow;
  if (typedAsset.type !== 'workflow') {
    return { ok: false, status: 400, body: { error: 'Only workflow listings can be imported.' } };
  }

  const viewerIsSeller = typedAsset.seller_user_id === userId;
  if (!viewerIsSeller) {
    const { data: purchase, error: purchaseError } = await adminSupabase
      .from('marketplace_purchases')
      .select('asset_id')
      .eq('asset_id', assetId)
      .eq('buyer_user_id', userId)
      .maybeSingle();

    if (purchaseError) {
      logBackendError('failed_to_validate_workflow_purchase_before_import', { error: purchaseError });
      return { ok: false, status: 500, body: { error: 'Failed to validate purchase.' } };
    }

    if (!purchase) {
      return { ok: false, status: 403, body: { error: 'Purchase required before importing this workflow.' } };
    }
  }

  const { data: content, error: contentError } = await adminSupabase
    .from('marketplace_asset_content')
    .select('workflow_graph')
    .eq('asset_id', assetId)
    .maybeSingle();

  const typedContent = content as MarketplaceAssetContentRow | null;
  if (contentError || !typedContent?.workflow_graph) {
    return { ok: false, status: 404, body: { error: 'Workflow content is unavailable for this listing.' } };
  }

  const graph = normalizeWorkflowGraph(typedContent.workflow_graph);
  const graphSnapshot = serializeWorkflowGraph(graph);
  const nextTitle = `Copy of ${safeWorkflowTitle(typedAsset.title)}`;

  const insertCanvas = async (useLifecycleColumns: boolean) => userSupabase
    .from('workflow_canvases')
    .insert({
      user_id: userId,
      title: nextTitle,
      graph: graphSnapshot,
      viewport: graph.viewport,
      ...(useLifecycleColumns ? { status: 'draft' } : {}),
    })
    .select(useLifecycleColumns ? WORKFLOW_CANVAS_SELECT : WORKFLOW_CANVAS_SELECT_LEGACY)
    .single();

  let { data: canvas, error: canvasError } = await insertCanvas(true);

  if (canvasError && isMissingWorkflowLifecycleColumnsError(canvasError)) {
    const legacyInsert = await insertCanvas(false);
    canvas = legacyInsert.data;
    canvasError = legacyInsert.error;
  }

  if (canvasError || !canvas) {
    logBackendError('failed_to_import_marketplace_workflow_asset', { error: canvasError });
    return { ok: false, status: 500, body: { error: 'Failed to import workflow.' } };
  }

  const canvasRecord = canvas as unknown as WorkflowCanvasImportRow;

  try {
    const { error: historyError } = await userSupabase
      .from('workflow_canvas_history')
      .insert({
        canvas_id: canvasRecord.id,
        user_id: userId,
        title: canvasRecord.title,
        graph: graphSnapshot,
        revision: canvasRecord.revision,
        kind: 'draft',
      });

    if (historyError && !isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      logBackendError('failed_to_write_imported_workflow_history_snapshot', { error: historyError });
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      logBackendError('failed_to_write_imported_workflow_history_snapshot', { error: historyError });
    }
  }

  return {
    ok: true,
    body: {
      success: true,
      redirectTo: '/create-workflow',
      canvas: withWorkflowCanvasLifecycleDefaults({
        ...canvasRecord,
        graph: normalizeWorkflowGraph(canvasRecord.graph),
      }),
    },
  };
}
