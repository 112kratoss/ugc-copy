import 'server-only';

import { createHash } from 'node:crypto';

import { quoteGenerationModel } from '@/lib/generation-model-catalog';
import {
  createTemplateVersionSnapshotGraph,
  getIncomingEdges,
  inspectWorkflowNodeCapabilities,
  normalizeNodeData,
  normalizeWorkflowGraph,
  validateWorkflowTemplateAuthoringGraph,
  type ApprovalGateNodeData,
  type ImageGenerateNodeData,
  type ImageInputNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
} from '@/lib/workflow-canvas';
import {
  MediaTemplateError,
  type CompiledTemplateGraph,
  type TemplateGraphValidationDto,
  type TemplateInputSlot,
  type TemplateMediaKind,
  type TemplateValidationIssue,
} from '@/lib/media-template-types';

export function createTemplateSnapshotHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function inputCountsForNode(graph: WorkflowCanvasGraph, node: WorkflowCanvasNode) {
  let images = 0;
  let videos = 0;
  let audios = 0;
  for (const edge of getIncomingEdges(graph, node.id)) {
    // Start/end frames have their own model capabilities and must not be
    // counted as generic references when quoting a video model.
    if (edge.targetHandle === 'image-reference') images += 1;
    if (edge.targetHandle === 'reference-video') videos += 1;
    if (edge.targetHandle === 'reference-audio') audios += 1;
  }
  return { images, videos, audios };
}

function quoteNode(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode,
  catalogRevision: string | null,
): number {
  const inputCounts = inputCountsForNode(graph, node);
  if (node.type === 'image-generate') {
    const data = normalizeNodeData('image-generate', node.data) as ImageGenerateNodeData;
    return quoteGenerationModel({
      kind: 'image',
      modelId: data.model,
      settings: {
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        outputFormat: data.outputFormat,
        googleSearch: data.googleSearch,
      },
      inputCounts,
      catalogRevision,
    }).costCredits;
  }
  if (node.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data) as VideoGenerateNodeData;
    const duration = data.isMultiShot
      ? data.multiPrompts.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration)), 0)
      : data.duration;
    return quoteGenerationModel({
      kind: 'video',
      modelId: data.model,
      settings: {
        mode: data.mode,
        aspectRatio: data.aspectRatio,
        sound: data.sound,
        duration,
        resolution: data.resolution,
        fixedLens: data.fixedLens,
        isMultiShot: data.isMultiShot,
      },
      inputCounts,
      catalogRevision,
    }).costCredits;
  }
  return 0;
}

export function validateAndCompileTemplateGraph(params: {
  graph: Partial<WorkflowCanvasGraph> | null | undefined;
  outputNodeId: string | null | undefined;
  canvasRevision: number;
  catalogRevision?: string | null;
}): { validation: TemplateGraphValidationDto; compiled: CompiledTemplateGraph | null } {
  const graph = normalizeWorkflowGraph(params.graph);
  const catalogRevision = params.catalogRevision?.trim() || null;
  const authoring = validateWorkflowTemplateAuthoringGraph({
    graph,
    outputNodeId: params.outputNodeId,
  });
  const issues: TemplateValidationIssue[] = [...authoring.issues];
  const pathNodeIds = new Set(authoring.path.nodeIds);
  const nodeCosts: Record<string, number> = {};

  for (const node of graph.nodes) {
    if (!pathNodeIds.has(node.id)) continue;

    if (node.type === 'image-input') {
      const data = node.data as ImageInputNodeData;
      if (data.templateInput.mode === 'fixed' && !data.storagePath) {
        issues.push({
          code: 'fixed-asset-not-durable',
          nodeId: node.id,
          message: `${data.title} must finish uploading before this template can be published.`,
        });
      }
    }
    if (node.type === 'video-input') {
      const data = node.data as VideoInputNodeData;
      if (data.templateInput.mode === 'fixed' && !data.storagePath) {
        issues.push({
          code: 'fixed-asset-not-durable',
          nodeId: node.id,
          message: `${data.title} must finish uploading before this template can be published.`,
        });
      }
    }

    if (node.type === 'image-generate' || node.type === 'video-generate') {
      const capabilities = inspectWorkflowNodeCapabilities(graph, node);
      const structuralIssues = capabilities.issues.filter((issue) => (
        // A published template deliberately has no consumer media or
        // intermediate outputs yet. Their availability is checked per run.
        issue.code !== 'missing-element-sources'
      ));
      if (structuralIssues.length > 0) {
        for (const issue of structuralIssues) {
          issues.push({ code: `model-${issue.code}`, nodeId: node.id, message: issue.message });
        }
        continue;
      }
      try {
        nodeCosts[node.id] = quoteNode(graph, node, catalogRevision);
      } catch (error) {
        issues.push({
          code: 'cost-unavailable',
          nodeId: node.id,
          message: error instanceof Error ? error.message : `Could not quote ${node.data.title}.`,
        });
      }
    }
  }

  const inputSlots: TemplateInputSlot[] = authoring.inputSlots.map((slot) => ({
    key: slot.key,
    kind: slot.kind,
    label: slot.label,
    ...(slot.description ? { description: slot.description } : {}),
    required: true,
  }));
  const outputKind = authoring.outputKind as TemplateMediaKind | null;
  const estimatedTotalCredits = Object.values(nodeCosts).reduce((total, cost) => total + cost, 0);
  const snapshot = params.outputNodeId
    ? createTemplateVersionSnapshotGraph(graph, params.outputNodeId)
    : null;
  const privateGraph = snapshot ? JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown> : null;
  const graphHash = privateGraph && issues.length === 0 ? createTemplateSnapshotHash(privateGraph) : null;

  const validation: TemplateGraphValidationDto = {
    valid: issues.length === 0 && Boolean(privateGraph && params.outputNodeId && outputKind),
    issues,
    inputSlots,
    outputKind,
    estimatedTotalCredits: issues.some((issue) => issue.code === 'cost-unavailable')
      ? null
      : estimatedTotalCredits,
    graphHash,
    canvasRevision: Math.max(0, Math.trunc(params.canvasRevision)),
  };

  if (!validation.valid || !privateGraph || !params.outputNodeId || !outputKind || !graphHash) {
    return { validation, compiled: null };
  }

  const inputNodeIds = Object.fromEntries(authoring.inputSlots.map((slot) => [slot.key, slot.nodeId]));
  return {
    validation,
    compiled: {
      graph: privateGraph,
      graphHash,
      outputNodeId: params.outputNodeId,
      outputKind,
      inputSlots,
      inputNodeIds,
      nodeCosts,
      estimatedTotalCredits,
      catalogRevision,
    },
  };
}

export function compileTemplateGraph(params: Parameters<typeof validateAndCompileTemplateGraph>[0]): CompiledTemplateGraph {
  const result = validateAndCompileTemplateGraph(params);
  if (!result.compiled) {
    throw new MediaTemplateError(
      result.validation.issues[0]?.message ?? 'The workflow cannot be used as a template.',
      400,
      'INVALID_TEMPLATE_GRAPH',
      result.validation.issues[0]?.nodeId
        ? { [result.validation.issues[0].nodeId!]: result.validation.issues[0].message }
        : undefined,
    );
  }
  return result.compiled;
}

export type TemplateStepDefinition = {
  nodeId: string;
  kind: 'generation' | 'approval';
  mediaKind: TemplateMediaKind;
  label: string;
  canRetry: boolean;
  estimatedCredits: number;
};

export function getTemplateStepDefinitions(compiled: CompiledTemplateGraph): TemplateStepDefinition[] {
  const graph = normalizeWorkflowGraph(compiled.graph as Partial<WorkflowCanvasGraph>);
  return graph.nodes.flatMap<TemplateStepDefinition>((node) => {
    if (node.type === 'image-generate' || node.type === 'video-generate') {
      return [{
        nodeId: node.id,
        kind: 'generation' as const,
        mediaKind: (node.type === 'image-generate' ? 'image' : 'video') as TemplateMediaKind,
        label: node.data.title,
        canRetry: true,
        estimatedCredits: compiled.nodeCosts[node.id] ?? 0,
      }];
    }
    if (node.type === 'approval-gate') {
      const data = node.data as ApprovalGateNodeData;
      const incoming = getIncomingEdges(graph, node.id)[0];
      const upstreamCost = incoming ? compiled.nodeCosts[incoming.source] ?? 0 : 0;
      return [{
        nodeId: node.id,
        kind: 'approval' as const,
        mediaKind: data.mediaKind,
        label: data.label || data.title,
        canRetry: data.allowRetry,
        estimatedCredits: upstreamCost,
      }];
    }
    return [];
  });
}
