import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';
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
} from '@/app/api/workflow-canvases/workflowCanvasRouteCompat';

interface RouteParams {
  params: Promise<{ assetId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { assetId } = await params;
    const supabase = createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = createServiceClient();
    const { data: asset, error: assetError } = await adminSupabase
      .from('marketplace_assets')
      .select('id, seller_user_id, type, title')
      .eq('id', assetId)
      .maybeSingle();

    if (assetError || !asset) {
      return NextResponse.json({ error: 'Workflow listing not found.' }, { status: 404 });
    }

    if (asset.type !== 'workflow') {
      return NextResponse.json({ error: 'Only workflow listings can be imported.' }, { status: 400 });
    }

    const viewerIsSeller = asset.seller_user_id === user.id;
    if (!viewerIsSeller) {
      const { data: purchase, error: purchaseError } = await adminSupabase
        .from('marketplace_purchases')
        .select('asset_id')
        .eq('asset_id', assetId)
        .eq('buyer_user_id', user.id)
        .maybeSingle();

      if (purchaseError) {
        console.error('Failed to validate workflow purchase before import:', purchaseError);
        return NextResponse.json({ error: 'Failed to validate purchase.' }, { status: 500 });
      }

      if (!purchase) {
        return NextResponse.json({ error: 'Purchase required before importing this workflow.' }, { status: 403 });
      }
    }

    const { data: content, error: contentError } = await adminSupabase
      .from('marketplace_asset_content')
      .select('workflow_graph')
      .eq('asset_id', assetId)
      .maybeSingle();

    if (contentError || !content?.workflow_graph) {
      return NextResponse.json({ error: 'Workflow content is unavailable for this listing.' }, { status: 404 });
    }

    const graph = normalizeWorkflowGraph(content.workflow_graph as Partial<WorkflowCanvasGraph>);
    const graphSnapshot = serializeWorkflowGraph(graph);
    const nextTitle = `Copy of ${(asset.title as string).trim() || 'Untitled workflow'}`;

    const insertCanvas = async (useLifecycleColumns: boolean) => supabase
      .from('workflow_canvases')
      .insert({
        user_id: user.id,
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
      console.error('Failed to import marketplace workflow asset:', canvasError);
      return NextResponse.json({ error: 'Failed to import workflow.' }, { status: 500 });
    }

    const canvasRecord = canvas as unknown as {
      id: string;
      title: string;
      graph: Partial<WorkflowCanvasGraph>;
      revision: number;
      created_at: string;
      updated_at: string;
      status?: 'draft' | 'published';
      published_at?: string | null;
    };

    try {
      const { error: historyError } = await supabase
        .from('workflow_canvas_history')
        .insert({
          canvas_id: canvasRecord.id,
          user_id: user.id,
          title: canvasRecord.title,
          graph: graphSnapshot,
          revision: canvasRecord.revision,
          kind: 'draft',
        });

      if (historyError && !isMissingWorkflowCanvasHistorySchemaError(historyError)) {
        console.error('Failed to write imported workflow history snapshot:', historyError);
      }
    } catch (historyError) {
      if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
        console.error('Failed to write imported workflow history snapshot:', historyError);
      }
    }

    return NextResponse.json({
      success: true,
      redirectTo: '/create-workflow',
      canvas: withWorkflowCanvasLifecycleDefaults({
        ...canvasRecord,
        graph: normalizeWorkflowGraph(canvasRecord.graph),
      }),
    });
  } catch (error) {
    console.error('Workflow asset import failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
