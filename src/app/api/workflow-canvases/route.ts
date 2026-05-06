import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server-helpers';
import {
  createStarterGraph,
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import {
  isMissingWorkflowCanvasHistorySchemaError,
  isMissingWorkflowLifecycleColumnsError,
  withWorkflowCanvasLifecycleDefaults,
  WORKFLOW_CANVAS_LIST_SELECT,
  WORKFLOW_CANVAS_LIST_SELECT_LEGACY,
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from './workflowCanvasRouteCompat';

type WorkflowCanvasListRow = {
  id: string;
  title: string;
  updated_at: string;
  revision: number;
  status?: string | null;
  published_at?: string | null;
};

type WorkflowCanvasRouteRow = WorkflowCanvasListRow & {
  graph: Partial<WorkflowCanvasGraph> | null;
  created_at: string;
};

export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { supabase, userId } = auth;
  let data: WorkflowCanvasListRow[] | null = null;
  let error: unknown = null;
  {
    const result = await supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_LIST_SELECT)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    data = (result.data as WorkflowCanvasListRow[] | null) ?? null;
    error = result.error;
  }

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyResult = await supabase
      .from('workflow_canvases')
      .select(WORKFLOW_CANVAS_LIST_SELECT_LEGACY)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    data = (legacyResult.data as WorkflowCanvasListRow[] | null) ?? null;
    error = legacyResult.error;
  }

  if (error) {
    console.error('Failed to fetch workflow canvases:', error);
    return NextResponse.json({ error: 'Failed to fetch workflow canvases.' }, { status: 500 });
  }

  return NextResponse.json({
    canvases: (data || []).map((canvas) => withWorkflowCanvasLifecycleDefaults(canvas)),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (auth instanceof NextResponse) return auth;

  const { supabase, userId } = auth;
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New workflow canvas';
  const graph = normalizeWorkflowGraph(body.graph || createStarterGraph());

  const insertCanvas = async (useLifecycleColumns: boolean) => {
    const insertQuery = supabase
      .from('workflow_canvases')
      .insert({
        user_id: userId,
        title,
        graph: serializeWorkflowGraph(graph),
        viewport: graph.viewport,
        ...(useLifecycleColumns ? { status: 'draft' } : {}),
      });
    const selectedQuery = useLifecycleColumns
      ? insertQuery.select(WORKFLOW_CANVAS_SELECT)
      : insertQuery.select(WORKFLOW_CANVAS_SELECT_LEGACY);
    const { data, error } = await selectedQuery.single();

    return {
      data: (data as WorkflowCanvasRouteRow | null) ?? null,
      error,
    };
  };

  let data: WorkflowCanvasRouteRow | null = null;
  let error: unknown = null;
  ({ data, error } = await insertCanvas(true));

  if (error && isMissingWorkflowLifecycleColumnsError(error)) {
    const legacyInsert = await insertCanvas(false);
    data = legacyInsert.data;
    error = legacyInsert.error;
  }

  if (error || !data) {
    console.error('Failed to create workflow canvas:', error);
    return NextResponse.json({ error: 'Failed to create workflow canvas.' }, { status: 500 });
  }

  const normalizedGraph = normalizeWorkflowGraph(data.graph);
  const canvas = withWorkflowCanvasLifecycleDefaults({
    ...data,
    graph: normalizedGraph,
  });

  try {
    const { error: historyError } = await supabase
      .from('workflow_canvas_history')
      .insert({
        canvas_id: data.id,
        user_id: userId,
        title: data.title,
        graph: serializeWorkflowGraph(normalizedGraph),
        revision: data.revision,
        kind: 'draft',
      });

    if (historyError && !isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      console.error('Failed to create initial workflow canvas history snapshot:', historyError);
    }
  } catch (historyError) {
    if (!isMissingWorkflowCanvasHistorySchemaError(historyError)) {
      console.error('Failed to create initial workflow canvas history snapshot:', historyError);
    }
  }

  return NextResponse.json({
    canvas,
  });
}
