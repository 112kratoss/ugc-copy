import {
  normalizeWorkflowGraph,
  type WorkflowCanvasGraph,
  type WorkflowCanvasOutputKind,
  type WorkflowCanvasPreview,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';

export const WORKFLOW_CANVAS_PREVIEW_NODE_LIMIT = 48;
export const WORKFLOW_CANVAS_PREVIEW_EDGE_LIMIT = 72;

const OUTPUT_KIND_BY_NODE_TYPE: Partial<Record<WorkflowNodeKind, WorkflowCanvasOutputKind>> = {
  'image-generate': 'image',
  'video-generate': 'video',
  'motion-generate': 'video',
  'voiceover-generate': 'audio',
  'music-generate': 'audio',
  'sound-effects-generate': 'audio',
};

export interface WorkflowCanvasLibrarySummary {
  preview: WorkflowCanvasPreview;
  node_count: number;
  connection_count: number;
  output_kinds: WorkflowCanvasOutputKind[];
}

/**
 * Builds the intentionally data-free shape used by the workflow library.
 * Node ids are replaced with local preview ids and node data is never copied.
 */
export function createWorkflowCanvasLibrarySummary(
  value: Partial<WorkflowCanvasGraph> | null | undefined,
): WorkflowCanvasLibrarySummary {
  const graph = normalizeWorkflowGraph(value);
  const previewNodes = graph.nodes.slice(0, WORKFLOW_CANVAS_PREVIEW_NODE_LIMIT);
  const previewIdByNodeId = new Map(
    previewNodes.map((node, index) => [node.id, `n${index}`]),
  );
  const previewEdges = graph.edges
    .flatMap((edge) => {
      const source = previewIdByNodeId.get(edge.source);
      const target = previewIdByNodeId.get(edge.target);
      return source && target ? [{ source, target }] : [];
    })
    .slice(0, WORKFLOW_CANVAS_PREVIEW_EDGE_LIMIT);
  const outputKinds = new Set<WorkflowCanvasOutputKind>();

  for (const node of graph.nodes) {
    const outputKind = OUTPUT_KIND_BY_NODE_TYPE[node.type as WorkflowNodeKind];
    if (outputKind) {
      outputKinds.add(outputKind);
    }
  }

  return {
    preview: {
      nodes: previewNodes.map((node, index) => ({
        id: `n${index}`,
        type: node.type as WorkflowNodeKind,
        position: {
          x: Number.isFinite(node.position.x) ? node.position.x : 0,
          y: Number.isFinite(node.position.y) ? node.position.y : 0,
        },
      })),
      edges: previewEdges,
      truncated: graph.nodes.length > WORKFLOW_CANVAS_PREVIEW_NODE_LIMIT
        || graph.edges.length > previewEdges.length,
    },
    node_count: graph.nodes.length,
    connection_count: graph.edges.length,
    output_kinds: [...outputKinds],
  };
}
