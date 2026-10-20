import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
import {
  getNodeById,
  getOutgoingEdges,
  getResolvedWorkflowImageReferences,
  getResolvedWorkflowVideoReferences,
  normalizeNodeData,
  resolveNodeInputs,
  type VideoGenerateNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowNodeData,
} from '@/lib/workflow-canvas';
import {
  creatorPromptViolation,
  groupPromptDigits,
  promptLengthMeter,
  promptLimitFor,
  type PromptLengthMeter,
} from '../../../ugc-mobile/lib/model-catalog/provider-prompt-limits';

/**
 * What a canvas generator holds the prompts it is sent to: its model's own limits
 * (provider-prompt-limits), as the creators hold them. A step past them is refused by
 * the start before anything is held; these say so in the node editors while the text
 * is being written, in the start's own words.
 */

type GeneratorKind = 'image' | 'video' | 'motion';

const GENERATOR_KINDS: Readonly<Record<string, GeneratorKind>> = {
  'image-generate': 'image',
  'video-generate': 'video',
  'motion-generate': 'motion',
};

/** The name the creators show for a model, as the start's refusal names it. */
export function workflowModelDisplayName(modelId: string): string {
  for (const models of [IMAGE_MODELS, VIDEO_MODELS, MOTION_MODELS] as const) {
    if (Object.hasOwn(models, modelId)) return (models as Record<string, { displayName: string }>)[modelId].displayName;
  }
  return modelId;
}

/** A canvas generator's prompts against its model's limits. */
export type WorkflowPromptLimitState = {
  nodeId: string;
  modelId: string;
  modelName: string;
  /** The prompt it is sent (every connected prompt node's text), against its limit. */
  meter: PromptLengthMeter;
  /** Each shot, for a multi-shot video generator. */
  shotMeters: PromptLengthMeter[];
  /** Why the start would refuse the step's prompts, or null. */
  violation: string | null;
};

/**
 * A generator's prompts against its model's limits, counted as the step sends them:
 * the text of every prompt node connected to it, joined, and a multi-shot video's own
 * shots. Null for any other node, and for one with no model.
 */
export function workflowGeneratorPromptLimits(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode,
): WorkflowPromptLimitState | null {
  const kind = GENERATOR_KINDS[node.type];
  const modelId = typeof node.data.model === 'string' ? node.data.model : '';
  if (!kind || !modelId) return null;
  const video = kind === 'video'
    ? normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData
    : null;
  const isMultiShot = Boolean(video?.isMultiShot);
  const prompt = resolveNodeInputs(graph, node.id).prompt ?? '';
  const shots = isMultiShot ? (video?.multiPrompts ?? []).map((shot) => shot.prompt) : [];
  const hasReferenceImages = getResolvedWorkflowImageReferences(graph, node.id).length > 0;
  // A Kling 3.0 step sends each connected clip as a named video element.
  const elementHandles = modelId === 'kling-3.0-video'
    ? getResolvedWorkflowVideoReferences(graph, node.id).map((reference) => reference.handle)
    : [];
  const limit = promptLimitFor(modelId, { hasReferenceImages, kind });
  const meterOptions = { elementMentionLength: limit.elementMentionLength, elementHandles };
  const meter = promptLengthMeter(prompt, limit.maxLength, meterOptions);
  const modelName = workflowModelDisplayName(modelId);
  const hasText = isMultiShot ? shots.some((shot) => shot.trim()) : Boolean(prompt.trim());
  const providerViolation = hasText
    ? creatorPromptViolation(modelId, modelName, { prompt, isMultiShot, shots, hasReferenceImages, elementHandles })
    : null;
  // A prompt node's box has no maxLength of its own, so the route's limit (10,000, or
  // 2,500 for motion) is said here too, in the same words, where the model sets none.
  const routeViolation = !isMultiShot && meter.state === 'over'
    ? `${modelName} prompts support up to ${groupPromptDigits(limit.maxLength)} characters.`
    : null;
  return {
    nodeId: node.id,
    modelId,
    modelName,
    meter,
    shotMeters: shots.map((shot) => promptLengthMeter(shot, limit.shotMaxLength, meterOptions)),
    violation: providerViolation ?? routeViolation,
  };
}

/**
 * The generators a prompt node's text is sent to (each one its text edge reaches;
 * a multi-shot video sends its own shots instead), with the limits each holds it to.
 */
export function workflowPromptNodeLimits(
  graph: WorkflowCanvasGraph,
  promptNodeId: string,
): WorkflowPromptLimitState[] {
  const seen = new Set<string>();
  const states: WorkflowPromptLimitState[] = [];
  for (const edge of getOutgoingEdges(graph, promptNodeId)) {
    if (edge.sourceHandle !== 'text' || seen.has(edge.target)) continue;
    seen.add(edge.target);
    const target = getNodeById(graph, edge.target);
    if (!target || (target.type === 'video-generate' && (target.data as Partial<VideoGenerateNodeData>).isMultiShot)) continue;
    const state = workflowGeneratorPromptLimits(graph, target);
    if (state) states.push(state);
  }
  return states;
}

/** The one a prompt node's counter reads: the tightest limit among the generators it feeds, the first refused among them first. */
export function tightestWorkflowPromptLimit(states: readonly WorkflowPromptLimitState[]): WorkflowPromptLimitState | null {
  return [...states].sort((a, b) => (
    Number(Boolean(b.violation)) - Number(Boolean(a.violation))
    || (a.meter.limit - a.meter.length) - (b.meter.limit - b.meter.length)
  ))[0] ?? null;
}
