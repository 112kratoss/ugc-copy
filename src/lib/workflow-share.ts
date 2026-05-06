import type { SerializedWorkflowCanvasGraph, WorkflowCanvasRecord } from '@/lib/workflow-canvas';

export const WORKFLOW_SHARE_SELECT = [
  'id',
  'owner_user_id',
  'source_canvas_id',
  'source_revision',
  'title',
  'graph',
  'node_count',
  'edge_count',
  'import_count',
  'created_at',
].join(', ');

export const WORKFLOW_SHARE_SUMMARY_SELECT = [
  'id',
  'title',
  'node_count',
  'edge_count',
  'import_count',
  'created_at',
].join(', ');

export interface WorkflowShareSummary {
  id: string;
  title: string;
  nodeCount: number;
  edgeCount: number;
  importCount: number;
  createdAt: string;
  importPath: string;
  importUrl: string;
}

export interface WorkflowSharePreview extends WorkflowShareSummary {
  graph: SerializedWorkflowCanvasGraph;
  sourceCanvasId: string | null;
  sourceRevision: number;
}

export interface WorkflowShareImportResponse {
  canvas: WorkflowCanvasRecord;
  share: WorkflowShareSummary;
}

export interface WorkflowShareRow {
  id: string;
  owner_user_id: string;
  source_canvas_id: string | null;
  source_revision: number;
  title: string;
  graph: SerializedWorkflowCanvasGraph;
  node_count: number;
  edge_count: number;
  import_count: number;
  created_at: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWorkflowShareId(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export function buildWorkflowShareImportPath(shareId: string): string {
  return `/create-workflow?import=${encodeURIComponent(shareId)}`;
}

export function buildWorkflowShareImportUrl(shareId: string, origin: string): string {
  return new URL(buildWorkflowShareImportPath(shareId), origin).toString();
}

export function extractWorkflowShareId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (isWorkflowShareId(trimmed)) {
    return trimmed;
  }

  try {
    const parsedUrl = new URL(trimmed, 'http://localhost');
    const shareId = parsedUrl.searchParams.get('import');
    return shareId && isWorkflowShareId(shareId) ? shareId : null;
  } catch {
    return null;
  }
}

export function toWorkflowShareSummary(
  row: Pick<WorkflowShareRow, 'id' | 'title' | 'node_count' | 'edge_count' | 'import_count' | 'created_at'>,
  origin: string
): WorkflowShareSummary {
  return {
    id: row.id,
    title: row.title,
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    importCount: row.import_count,
    createdAt: row.created_at,
    importPath: buildWorkflowShareImportPath(row.id),
    importUrl: buildWorkflowShareImportUrl(row.id, origin),
  };
}

export function toWorkflowSharePreview(
  row: WorkflowShareRow,
  origin: string
): WorkflowSharePreview {
  return {
    ...toWorkflowShareSummary(row, origin),
    graph: row.graph,
    sourceCanvasId: row.source_canvas_id,
    sourceRevision: row.source_revision,
  };
}
