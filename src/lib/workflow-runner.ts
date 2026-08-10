import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import { logBackendError } from '@/lib/backend-logger';
import { enqueueWorkflowRunStepJob } from '@/lib/workflow-run-jobs';
import {
  startImageGeneration,
  startMotionGeneration,
  startSoundEffectGeneration,
  startVideoGeneration,
  startVoiceoverGeneration,
  type TemplateGenerationContext,
} from '@/lib/generation-services';
import {
  getHeldProviderSubmissionGenerationId,
  getPublicGenerationStartFailure,
} from '@/lib/generation-public-failure';
import { syncGenerationStatuses } from '@/lib/generation-status-sync';
import {
  type ApprovalGateNodeData,
  type AudioInputNodeData,
  type ImageInputNodeData,
  getExecutionOrder,
  getIncomingEdges,
  getNodeById,
  getNodeOutputUrl,
  getResolvedWorkflowImageReferences,
  getResolvedWorkflowVideoReferences,
  inspectWorkflowNodeDependencies,
  isApprovalGateNode,
  isSeedance2VideoModel,
  isRunnableNode,
  normalizeNodeData,
  normalizeWorkflowGraph,
  resolveNodeInputs,
  serializeWorkflowGraph,
  updateNodeRunState,
  type ImageGenerateNodeData,
  type MotionGenerateNodeData,
  type WorkflowCanvasRunRecord,
  type SoundEffectsGenerateNodeData,
  type VideoInputNodeData,
  type VideoGenerateNodeData,
  type VoiceoverGenerateNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowCanvasRunStepRecord,
  type WorkflowRunStatus,
} from '@/lib/workflow-canvas';
import {
  createSeedanceAssetMetadata,
  getPreferredSeedanceReferenceValue,
  type SeedanceAssetCollections,
  type SeedanceAssetMetadata,
} from '@/lib/seedance-assets';
import { quotePublishedGenerationModel } from '@/lib/generation-model-catalog-store';

export interface WorkflowRunExecutionResult {
  runId: string;
  status: 'processing' | 'awaiting_approval' | 'succeeded' | 'failed';
  /**
   * True when an idempotency key matched an existing run and the graph was
   * deliberately NOT executed again. Callers should treat this as success --
   * the run the caller asked for exists -- not as a rejected request.
   */
  reused?: boolean;
}

export class WorkflowRunApprovalError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'WorkflowRunApprovalError';
  }
}

export interface WorkflowRunnableExecutionResult {
  status: 'processing' | 'awaiting_approval' | 'blocked';
  generation_id: string | null;
  input_snapshot: Record<string, unknown> | null;
  output_snapshot: Record<string, unknown> | null;
  error_message: string | null;
}

interface HydratedRunStep extends WorkflowCanvasRunStepRecord {
  generation_id: string | null;
}

interface WorkflowRunRow {
  id: string;
  canvas_id: string;
  user_id: string;
  start_node_id: string;
  mode: 'node' | 'branch';
  status: 'processing' | 'awaiting_approval' | 'succeeded' | 'failed';
  created_at: string;
  finished_at: string | null;
  catalog_revision: string | null;
  graph_snapshot: WorkflowCanvasGraph | null;
}

interface GenerationStatusSnapshot {
  status: WorkflowRunStatus;
  output_url: string | null;
}

type WorkflowRunResponse = WorkflowCanvasRunRecord & {
  steps: HydratedRunStep[];
};

const activeWorkflowRunAdvances = new Map<string, Promise<WorkflowRunResponse>>();

function getRunnableElementPayload(
  graph: WorkflowCanvasGraph,
  nodeId: string
) {
  const resolvedReferences = getResolvedWorkflowImageReferences(graph, nodeId);

  return {
    descriptors: resolvedReferences
      .filter((reference) => Boolean(reference.handle))
      .map((reference) => ({
        id: reference.id,
        displayName: reference.displayName,
        handle: reference.handle!,
        storagePath: reference.storagePath,
        sourceGenerationId: reference.sourceGenerationId,
      })),
    references: resolvedReferences
      .map((reference) => {
        const url = reference.storagePath || reference.url || null;
        if (!url) {
          return null;
        }

        return {
          url,
          handle: reference.handle,
          displayName: reference.displayName,
          storagePath: reference.storagePath,
          sourceGenerationId: reference.sourceGenerationId,
        };
      })
      .filter((reference): reference is {
        url: string;
        handle: string | null;
        displayName: string;
        storagePath: string | null;
        sourceGenerationId: string | null;
      } => Boolean(reference)),
  };
}

function getSeedanceAssetFromSourceNode(source: WorkflowCanvasNode | undefined): SeedanceAssetMetadata | null {
  if (!source) {
    return null;
  }

  if (source.type === 'image-input') {
    return (normalizeNodeData('image-input', source.data as Partial<ImageInputNodeData>) as ImageInputNodeData).seedanceAsset;
  }

  if (source.type === 'video-input') {
    return (normalizeNodeData('video-input', source.data as Partial<VideoInputNodeData>) as VideoInputNodeData).seedanceAsset;
  }

  if (source.type === 'audio-input') {
    return (normalizeNodeData('audio-input', source.data as Partial<AudioInputNodeData>) as AudioInputNodeData).seedanceAsset;
  }

  return null;
}

function getSeedanceReferenceCollections(
  graph: WorkflowCanvasGraph,
  nodeId: string
): {
  descriptors: ReturnType<typeof getRunnableElementPayload>['descriptors'];
  references: ReturnType<typeof getRunnableElementPayload>['references'];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
  seedanceAssets: SeedanceAssetCollections;
} {
  const resolvedImageReferences = getResolvedWorkflowImageReferences(graph, nodeId);
  const references = resolvedImageReferences
    .map((reference) => {
      const source = reference.sourceNodeId ? getNodeById(graph, reference.sourceNodeId) : null;
      const asset = getSeedanceAssetFromSourceNode(source || undefined);
      const url = getPreferredSeedanceReferenceValue(reference.storagePath || reference.url || null, asset);
      if (!url) {
        return null;
      }

      return {
        url,
        handle: reference.handle,
        displayName: reference.displayName,
        storagePath: reference.storagePath,
        sourceGenerationId: reference.sourceGenerationId,
      };
    })
    .filter((reference): reference is ReturnType<typeof getRunnableElementPayload>['references'][number] => Boolean(reference));
  const descriptors = resolvedImageReferences
    .filter((reference) => Boolean(reference.handle))
    .map((reference) => ({
      id: reference.id,
      displayName: reference.displayName,
      handle: reference.handle!,
      storagePath: reference.storagePath,
      sourceGenerationId: reference.sourceGenerationId,
    }));

  const videoAssets: SeedanceAssetMetadata[] = [];
  const audioAssets: SeedanceAssetMetadata[] = [];
  const referenceVideoUrls: string[] = [];
  const referenceAudioUrls: string[] = [];

  for (const edge of getIncomingEdges(graph, nodeId)) {
    if (edge.targetHandle !== 'reference-video' && edge.targetHandle !== 'reference-audio') {
      continue;
    }

    const source = getNodeById(graph, edge.source);
    const outputUrl = source ? getNodeOutputUrl(source) : null;
    const asset = getSeedanceAssetFromSourceNode(source);
    const referenceValue = getPreferredSeedanceReferenceValue(outputUrl, asset);
    if (!referenceValue) {
      continue;
    }

    if (edge.targetHandle === 'reference-video') {
      referenceVideoUrls.push(referenceValue);
      videoAssets.push(asset ? { ...asset } : createSeedanceAssetMetadata({ assetType: 'Video', sourceUrl: outputUrl }));
      continue;
    }

    referenceAudioUrls.push(referenceValue);
    audioAssets.push(asset ? { ...asset } : createSeedanceAssetMetadata({ assetType: 'Audio', sourceUrl: outputUrl }));
  }

  return {
    descriptors,
    references,
    referenceVideoUrls,
    referenceAudioUrls,
    seedanceAssets: {
      images: resolvedImageReferences.map((reference) => {
        const source = reference.sourceNodeId ? getNodeById(graph, reference.sourceNodeId) : null;
        const asset = getSeedanceAssetFromSourceNode(source || undefined);
        return asset
          ? { ...asset }
          : createSeedanceAssetMetadata({ assetType: 'Image', sourceUrl: reference.storagePath || reference.url });
      }),
      videos: videoAssets,
      audios: audioAssets,
    },
  };
}

function getKlingVideoElementPayload(
  graph: WorkflowCanvasGraph,
  nodeId: string
) {
  return getResolvedWorkflowVideoReferences(graph, nodeId)
    .map((reference) => {
      const sourceValue = reference.storagePath || reference.url;
      if (!sourceValue) {
        return null;
      }

      return {
        id: reference.id,
        url: sourceValue,
        handle: reference.handle,
        displayName: reference.displayName,
        storagePath: reference.storagePath,
        sourceGenerationId: reference.sourceGenerationId,
      };
    })
    .filter((reference): reference is {
      id: string;
      url: string;
      handle: string;
      displayName: string;
      storagePath: string | null;
      sourceGenerationId: string | null;
    } => Boolean(reference));
}

function buildBlockedError(message: string): WorkflowRunnableExecutionResult {
  return {
    status: 'blocked',
    generation_id: null,
    input_snapshot: null,
    output_snapshot: null,
    error_message: message,
  };
}

function buildStaticOutputSnapshot(node: WorkflowCanvasNode) {
  return {
    outputUrl:
      node.type === 'image-input'
        ? node.data.imageUrl
        : node.type === 'video-input'
          ? node.data.videoUrl
          : node.type === 'audio-input'
            ? (node.data as AudioInputNodeData).audioUrl
            : 'text' in node.data
              ? node.data.text
              : null,
  };
}

function applyStepToGraph(graph: WorkflowCanvasGraph, step: HydratedRunStep): WorkflowCanvasGraph {
  const outputUrl = (step.output_snapshot as { outputUrl?: string } | null)?.outputUrl || null;
  const cost = (step.output_snapshot as { cost?: number | null } | null)?.cost ?? null;

  return updateNodeRunState(graph, step.node_id, {
    status: step.status,
    generationId: step.generation_id,
    outputUrl,
    error: step.error_message,
    cost,
    updatedAt: step.finished_at || step.started_at,
  });
}

async function updateRunStep(
  supabase: SupabaseClient,
  stepId: string,
  updates: Record<string, unknown>
) {
  await supabase
    .from('workflow_canvas_run_steps')
    .update(updates)
    .eq('id', stepId);
}

function getWorkflowRunMonitorKey(canvasId: string, runId: string) {
  return `${canvasId}:${runId}`;
}

function mapGenerationStatus(status: string): WorkflowRunStatus {
  if (status === 'succeeded') {
    return 'succeeded';
  }

  if (status === 'processing') {
    return 'processing';
  }

  return 'failed';
}

function getDerivedStepFinishedAt(step: HydratedRunStep, status: WorkflowRunStatus): string | null {
  if (status === 'processing' || status === 'queued' || status === 'awaiting_approval') {
    return null;
  }

  return step.finished_at || step.started_at || null;
}

function hasStepChanged(previous: HydratedRunStep, next: HydratedRunStep) {
  return (
    previous.status !== next.status
    || previous.finished_at !== next.finished_at
    || previous.error_message !== next.error_message
    || JSON.stringify(previous.output_snapshot ?? null) !== JSON.stringify(next.output_snapshot ?? null)
  );
}

function deriveWorkflowRunStatus(steps: HydratedRunStep[]): 'processing' | 'awaiting_approval' | 'succeeded' | 'failed' {
  // An empty step set means initialization died before durable ownership was
  // established. It must never be interpreted as successful completion.
  if (steps.length === 0) return 'failed';

  if (steps.some((step) => step.status === 'failed' || step.status === 'blocked')) {
    return 'failed';
  }

  if (steps.some((step) => step.status === 'processing')) {
    return 'processing';
  }

  if (steps.some((step) => step.status === 'awaiting_approval')) {
    return 'awaiting_approval';
  }

  if (steps.some((step) => step.status === 'queued')) return 'processing';

  return 'succeeded';
}

function workflowGenerationIdempotencyHash(runId: string, nodeId: string, attempt = 1) {
  return createHash('sha256')
    .update(`workflow-run:${runId}:${nodeId}:${attempt}`)
    .digest('hex');
}

function getDerivedRunFinishedAt(run: WorkflowRunRow, status: 'processing' | 'awaiting_approval' | 'succeeded' | 'failed', steps: HydratedRunStep[]) {
  if (status === 'processing' || status === 'awaiting_approval') {
    return null;
  }

  const latestFinishedAt = steps.reduce<string | null>((latest, step) => {
    if (!step.finished_at) {
      return latest;
    }

    if (!latest || step.finished_at > latest) {
      return step.finished_at;
    }

    return latest;
  }, null);

  return run.finished_at || latestFinishedAt || run.created_at;
}

function buildWorkflowRunResponse(run: WorkflowRunRow, steps: HydratedRunStep[]): WorkflowRunResponse {
  const status = deriveWorkflowRunStatus(steps);
  const finished_at = getDerivedRunFinishedAt(run, status, steps);

  return {
    id: run.id,
    canvas_id: run.canvas_id,
    start_node_id: run.start_node_id,
    mode: run.mode,
    status,
    created_at: run.created_at,
    finished_at,
    steps,
  };
}

// Exported for the durable queue worker (F12). The in-process dedupe map below
// still collapses concurrent advances inside one function instance; it is no
// longer the only thing that moves a run forward.
export async function advanceWorkflowRunOnce(params: {
  supabase: SupabaseClient;
  canvasId: string;
  runId: string;
}) {
  const { canvasId, runId } = params;
  const monitorKey = getWorkflowRunMonitorKey(canvasId, runId);
  const existingAdvance = activeWorkflowRunAdvances.get(monitorKey);
  if (existingAdvance) {
    return existingAdvance;
  }

  const nextAdvance = advanceWorkflowRunProgress(params).finally(() => {
    activeWorkflowRunAdvances.delete(monitorKey);
  });
  activeWorkflowRunAdvances.set(monitorKey, nextAdvance);
  return nextAdvance;
}

async function loadWorkflowRunState(params: {
  supabase: SupabaseClient;
  canvasId: string;
  runId: string;
}) {
  const { supabase, canvasId, runId } = params;
  const { data: run, error } = await supabase
    .from('workflow_canvas_runs')
    .select('id, canvas_id, user_id, start_node_id, mode, status, created_at, finished_at, catalog_revision, graph_snapshot')
    .eq('canvas_id', canvasId)
    .eq('id', runId)
    .single();

  if (error || !run) {
    throw new Error('Workflow run not found.');
  }

  const typedRun = run as WorkflowRunRow;
  let runGraph = typedRun.graph_snapshot;
  if (!runGraph) {
    const { data: canvas } = await supabase
      .from('workflow_canvases')
      .select('graph')
      .eq('id', canvasId)
      .single();
    runGraph = (canvas?.graph as WorkflowCanvasGraph | null | undefined) ?? null;
  }

  const { data: steps } = await supabase
    .from('workflow_canvas_run_steps')
    .select('id, node_id, status, generation_id, input_snapshot, output_snapshot, error_message, started_at, finished_at')
    .eq('run_id', runId)
    .order('started_at', { ascending: true });

  return {
    run: typedRun,
    graph: normalizeWorkflowGraph(runGraph),
    steps: (steps || []) as HydratedRunStep[],
  };
}

async function hydrateRunSteps(params: {
  steps: HydratedRunStep[];
  syncGenerationState?: boolean;
}) {
  const { steps, syncGenerationState = false } = params;
  const generationIds = steps.map((step) => step.generation_id).filter(Boolean) as string[];

  if (generationIds.length === 0) {
    return steps;
  }

  // The ids come from run steps the caller already loaded through the
  // user-scoped client, so ownership is established. The reads below need
  // columns (output_url, workflow_settings) that authenticated clients hold no
  // grant for, so they must run service-role.
  const adminSupabase = createServiceClient();

  if (syncGenerationState) {
    await syncGenerationStatuses({
      supabase: adminSupabase,
      creditSupabase: adminSupabase,
      generationIds,
    });
  }

  const generationMap = new Map<string, GenerationStatusSnapshot>();
  const { data: generations } = await adminSupabase
    .from('generations')
    .select('id, status, output_url')
    .in('id', generationIds);

  const resolvedGenerations = await Promise.all((generations || []).map(async (generation) => ({
    id: generation.id,
    status: mapGenerationStatus(generation.status),
    output_url: generation.output_url
      ? await resolveStoredMediaUrl(adminSupabase, generation.output_url)
      : null,
  })));

  for (const generation of resolvedGenerations) {
    generationMap.set(generation.id, {
      status: generation.status,
      output_url: generation.output_url,
    });
  }

  return steps.map((step) => {
    if (!step.generation_id) {
      return step;
    }

    const generation = generationMap.get(step.generation_id);
    if (!generation) {
      return step;
    }

    const nextStatus = generation.status;
    return {
      ...step,
      status: nextStatus,
      output_snapshot: {
        ...(step.output_snapshot as Record<string, unknown> | null),
        outputUrl: generation.output_url,
      },
      finished_at: getDerivedStepFinishedAt(step, nextStatus),
    };
  });
}

async function persistHydratedStepUpdates(
  supabase: SupabaseClient,
  originalSteps: HydratedRunStep[],
  hydratedSteps: HydratedRunStep[]
) {
  const originalById = new Map(originalSteps.map((step) => [step.id, step]));

  for (const step of hydratedSteps) {
    const previous = originalById.get(step.id);
    if (!previous || !hasStepChanged(previous, step)) {
      continue;
    }

    await updateRunStep(supabase, step.id, {
      status: step.status,
      output_snapshot: step.output_snapshot,
      error_message: step.error_message,
      finished_at: step.finished_at,
    });
  }
}

export async function executeWorkflowRunnableNode(params: {
  supabase: SupabaseClient;
  userId: string;
  node: WorkflowCanvasNode;
  graph: WorkflowCanvasGraph;
  catalogRevision?: string | null;
  clientRequestKeyHash?: string | null;
  persistInputMedia?: boolean;
  privateRecipe?: boolean;
  templateContext?: TemplateGenerationContext;
}): Promise<WorkflowRunnableExecutionResult> {
  const {
    supabase,
    userId,
    node,
    graph,
    catalogRevision = null,
    clientRequestKeyHash = null,
    persistInputMedia = true,
    privateRecipe = false,
    templateContext,
  } = params;
  const creditSupabase = createServiceClient();
  const inputs = resolveNodeInputs(graph, node.id);

  if (isApprovalGateNode(node)) {
    const data = normalizeNodeData('approval-gate', node.data as Partial<ApprovalGateNodeData>) as ApprovalGateNodeData;
    const sourceEdge = getIncomingEdges(graph, node.id)[0];
    const sourceNode = sourceEdge ? getNodeById(graph, sourceEdge.source) : null;
    const pendingOutputUrl = sourceNode ? getNodeOutputUrl(sourceNode) : null;
    if (!pendingOutputUrl) {
      return buildBlockedError(`Approval checkpoint is missing its ${data.mediaKind} output.`);
    }

    return {
      status: 'awaiting_approval',
      generation_id: null,
      input_snapshot: inputs,
      output_snapshot: {
        pendingOutputUrl,
        mediaKind: data.mediaKind,
        label: data.label,
        allowRetry: data.allowRetry,
      },
      error_message: null,
    };
  }

  if (node.type === 'image-generate') {
    if (!inputs.prompt) return buildBlockedError('Image generator is missing a prompt input.');
    const data = normalizeNodeData('image-generate', node.data as Partial<ImageGenerateNodeData>) as ImageGenerateNodeData;
    const elementPayload = getRunnableElementPayload(graph, node.id);
    const quote = await quotePublishedGenerationModel({
      kind: 'image',
      modelId: data.model,
      settings: {
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        outputFormat: data.outputFormat,
        googleSearch: data.googleSearch,
      },
      inputCounts: { images: elementPayload.references.length, videos: 0, audios: 0 },
      catalogRevision,
    }, { platform: 'web' });
    const result = await startImageGeneration({
      supabase,
      creditSupabase,
      userId,
      prompt: inputs.prompt,
      model: data.model,
      references: elementPayload.references,
      elements: elementPayload.descriptors,
      aspectRatio: data.aspectRatio,
      resolution: data.resolution,
      outputFormat: data.outputFormat,
      googleSearch: data.googleSearch,
      quotedCostCredits: quote.costCredits,
      clientRequestKeyHash,
      persistInputMedia,
      privateRecipe,
      templateContext,
    });

    return {
      status: 'processing',
      generation_id: result.generationId ?? null,
      output_snapshot: {
        predictionId: result.predictionId,
        cost: result.cost,
      },
      input_snapshot: inputs,
      error_message: null,
    };
  }

  if (node.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data as Partial<VideoGenerateNodeData>) as VideoGenerateNodeData;
    if (!data.isMultiShot && !inputs.prompt) {
      return buildBlockedError('Video generator is missing a prompt input.');
    }
    const isSeedance2Family = isSeedance2VideoModel(data.model);
    const isKlingVideoModel = data.model === 'kling-3.0-video';
    const elementPayload = isSeedance2Family
      ? getSeedanceReferenceCollections(graph, node.id)
      : {
          ...getRunnableElementPayload(graph, node.id),
          referenceVideoUrls: [] as string[],
          referenceAudioUrls: [] as string[],
          seedanceAssets: null as SeedanceAssetCollections | null,
        };
    const klingVideoElements = isKlingVideoModel
      ? getKlingVideoElementPayload(graph, node.id)
      : [];
    const quotedDuration = data.isMultiShot
      ? data.multiPrompts.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration || 0)), 0)
      : data.duration;
    const quote = await quotePublishedGenerationModel({
      kind: 'video',
      modelId: data.model,
      settings: {
        mode: data.mode,
        aspectRatio: data.aspectRatio,
        sound: data.sound,
        duration: quotedDuration,
        resolution: data.resolution,
        fixedLens: data.fixedLens,
        isMultiShot: data.isMultiShot,
      },
      inputCounts: {
        // Start/end frames are validated by their dedicated capabilities and
        // are not generic image references for catalog limits or pricing.
        images: elementPayload.references.length,
        videos: elementPayload.referenceVideoUrls.length + klingVideoElements.length,
        audios: elementPayload.referenceAudioUrls.length,
      },
      catalogRevision,
    }, { platform: 'web' });
    const result = await startVideoGeneration({
      supabase,
      creditSupabase,
      userId,
      prompt: inputs.prompt || '',
      model: data.model,
      references: elementPayload.references,
      isMultiShot: data.isMultiShot,
      multiPrompts: data.multiPrompts,
      elements: elementPayload.descriptors,
      referenceVideoUrls: elementPayload.referenceVideoUrls,
      referenceAudioUrls: elementPayload.referenceAudioUrls,
      klingVideoElements,
      startImageUrl: inputs.startFrameUrl,
      endImageUrl: inputs.endFrameUrl,
      mode: data.mode,
      aspectRatio: data.aspectRatio,
      sound: data.sound,
      duration: data.duration,
      resolution: data.resolution,
      fixedLens: data.fixedLens,
      seedanceAssets: elementPayload.seedanceAssets,
      quotedCostCredits: quote.costCredits,
      clientRequestKeyHash,
      persistInputMedia,
      privateRecipe,
      templateContext,
    });

    return {
      status: 'processing',
      generation_id: result.generationId ?? null,
      output_snapshot: {
        predictionId: result.predictionId,
        cost: result.cost,
      },
      input_snapshot: inputs,
      error_message: null,
    };
  }

  if (node.type === 'motion-generate') {
    const data = normalizeNodeData('motion-generate', node.data as Partial<MotionGenerateNodeData>) as MotionGenerateNodeData;
    const prompt = inputs.prompt || 'Match the reference motion naturally while preserving character consistency.';
    const referenceVideoUrl = inputs.videoUrls[0] || null;
    const characterImageUrl = inputs.imageReferences[0]?.url || null;

    if (!referenceVideoUrl || !characterImageUrl) {
      return buildBlockedError('Motion control requires both an image input and a video input.');
    }

    const quote = await quotePublishedGenerationModel({
      kind: 'motion',
      modelId: data.model,
      settings: {
        resolution: data.mode,
        characterOrientation: data.characterOrientation,
        duration: 10,
      },
      inputCounts: { images: 1, videos: 1, audios: 0 },
      catalogRevision,
    }, { platform: 'web' });
    const result = await startMotionGeneration({
      supabase,
      creditSupabase,
      userId,
      prompt,
      model: data.model,
      referenceVideoUrl,
      characterImageUrl,
      duration: 10,
      characterOrientation: data.characterOrientation,
      mode: data.mode,
      quotedCostCredits: quote.costCredits,
    });

    return {
      status: 'processing',
      generation_id: result.generationId ?? null,
      output_snapshot: {
        predictionId: result.predictionId,
        cost: result.cost,
      },
      input_snapshot: inputs,
      error_message: null,
    };
  }

  if (node.type === 'voiceover-generate') {
    const data = node.data as VoiceoverGenerateNodeData;
    if (data.model !== 'text-to-dialogue-v3' && !inputs.prompt) {
      return buildBlockedError('Voiceover node is missing a prompt input.');
    }
    if (data.model === 'text-to-dialogue-v3' && data.dialogueTurns.length === 0) {
      return buildBlockedError('Dialogue voiceover requires at least one turn.');
    }

    const result = await startVoiceoverGeneration({
      supabase,
      creditSupabase,
      userId,
      model: data.model,
      text: inputs.prompt || undefined,
      voice: data.voice,
      languageCode: data.languageCode,
      stability: data.stability,
      similarityBoost: data.similarityBoost,
      style: data.style,
      speed: data.speed,
      timestamps: data.timestamps,
      dialogueTurns: data.dialogueTurns,
    });

    return {
      status: 'processing',
      generation_id: result.generationId ?? null,
      output_snapshot: {
        predictionId: result.predictionId,
        cost: result.cost,
        model: data.model,
      },
      input_snapshot: {
        ...inputs,
        dialogueTurns: data.dialogueTurns,
      },
      error_message: null,
    };
  }

  if (node.type === 'music-generate') {
    return buildBlockedError('Music generation is not included in this audio pass yet.');
  }

  if (node.type === 'sound-effects-generate') {
    if (!inputs.prompt) return buildBlockedError('Sound effects node is missing a prompt input.');
    const data = node.data as SoundEffectsGenerateNodeData;
    const result = await startSoundEffectGeneration({
      supabase,
      creditSupabase,
      userId,
      prompt: inputs.prompt,
      model: data.model,
      duration: data.duration,
      loop: data.loop,
      promptInfluence: data.promptInfluence,
      outputFormat: data.outputFormat,
    });

    return {
      status: 'processing',
      generation_id: result.generationId ?? null,
      output_snapshot: {
        predictionId: result.predictionId,
        cost: result.cost,
        model: data.model,
      },
      input_snapshot: inputs,
      error_message: null,
    };
  }

  return buildBlockedError('Selected node is not runnable.');
}

export async function executeWorkflowRun(params: {
  supabase: SupabaseClient;
  userId: string;
  canvasId: string;
  graph: WorkflowCanvasGraph;
  startNodeId: string;
  mode: 'node' | 'branch';
  catalogRevision?: string | null;
  idempotencyKey?: string | null;
}): Promise<WorkflowRunExecutionResult> {
  const {
    supabase,
    userId,
    canvasId,
    graph,
    startNodeId,
    mode,
    catalogRevision = null,
    idempotencyKey = null,
  } = params;
  if (!idempotencyKey?.trim()) {
    throw new Error('Workflow run idempotency key is required.');
  }
  // A canvas can still have an in-memory overlay from a previous run. Start
  // every execution from the editable graph only so stale generation outputs
  // can never satisfy dependencies in a new run.
  const executionGraph = normalizeWorkflowGraph(
    serializeWorkflowGraph(graph, { mode: 'client-save' }) as unknown as Partial<WorkflowCanvasGraph>,
  );
  const executionOrder = getExecutionOrder(executionGraph, startNodeId, mode);
  if (executionOrder.length === 0) {
    throw new Error('Workflow run has no executable steps.');
  }

  // F12: one transaction creates the idempotent run, its complete step
  // skeleton, and the first leased-worker ticket. No provider work occurs in
  // this request. A function death therefore leaves either nothing or a fully
  // recoverable run, never paid work with a partial/empty step set.
  const runStart = await supabase.rpc('initialize_workflow_canvas_run', {
    p_canvas_id: canvasId,
    p_user_id: userId,
    p_start_node_id: startNodeId,
    p_mode: mode,
    p_catalog_revision: catalogRevision,
    p_graph_snapshot: serializeWorkflowGraph(executionGraph, { mode: 'client-save' }),
    p_idempotency_key: idempotencyKey,
    p_step_skeleton: executionOrder.map((nodeId) => ({ nodeId })),
  });

  if (runStart.error) {
    throw runStart.error;
  }

  const startedRun = (Array.isArray(runStart.data) ? runStart.data[0] : runStart.data) as {
    run_id?: string;
    run_status?: WorkflowRunExecutionResult['status'];
    reused?: boolean;
  } | null;
  const runId = startedRun?.run_id;

  // Previously the insert's error was never read, so a failed insert left runId
  // undefined and every step below was written against a null run.
  if (!runId) {
    throw new Error('Workflow run could not be created.');
  }

  return {
    runId,
    status: startedRun?.run_status ?? 'processing',
    reused: startedRun?.reused === true,
  };
}

async function advanceWorkflowRunProgress(params: {
  supabase: SupabaseClient;
  canvasId: string;
  runId: string;
}) {
  const { supabase, canvasId, runId } = params;
  const { run, graph, steps: originalSteps } = await loadWorkflowRunState({
    supabase,
    canvasId,
    runId,
  });
  const hydratedSteps = await hydrateRunSteps({
    steps: originalSteps,
    syncGenerationState: true,
  });

  await persistHydratedStepUpdates(supabase, originalSteps, hydratedSteps);

  let workingGraph = graph;
  for (const step of hydratedSteps) {
    workingGraph = applyStepToGraph(workingGraph, step);
  }

  const executionOrder = getExecutionOrder(workingGraph, run.start_node_id, run.mode);
  const stepIndexByNodeId = new Map(hydratedSteps.map((step, index) => [step.node_id, index]));
  for (const nodeId of executionOrder) {
    const stepIndex = stepIndexByNodeId.get(nodeId);
    if (stepIndex === undefined || hydratedSteps[stepIndex].status !== 'queued') {
      continue;
    }

    const queuedStep = hydratedSteps[stepIndex];
    const node = getNodeById(workingGraph, nodeId);
    if (!node) {
      const finishedAt = new Date().toISOString();
      const failedStep: HydratedRunStep = {
        ...queuedStep,
        status: 'failed',
        error_message: 'Workflow step is missing from the immutable run graph.',
        started_at: queuedStep.started_at || finishedAt,
        finished_at: finishedAt,
      };
      hydratedSteps[stepIndex] = failedStep;
      await updateRunStep(supabase, queuedStep.id, {
        status: failedStep.status,
        error_message: failedStep.error_message,
        started_at: failedStep.started_at,
        finished_at: failedStep.finished_at,
      });
      continue;
    }

    if (!isRunnableNode(node) && !isApprovalGateNode(node)) {
      const startedAt = queuedStep.started_at || new Date().toISOString();
      const staticStep: HydratedRunStep = {
        ...queuedStep,
        status: 'succeeded',
        input_snapshot: resolveNodeInputs(workingGraph, node.id),
        output_snapshot: buildStaticOutputSnapshot(node),
        error_message: null,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
      hydratedSteps[stepIndex] = staticStep;
      workingGraph = applyStepToGraph(workingGraph, staticStep);
      await updateRunStep(supabase, queuedStep.id, {
        status: staticStep.status,
        input_snapshot: staticStep.input_snapshot,
        output_snapshot: staticStep.output_snapshot,
        error_message: null,
        started_at: staticStep.started_at,
        finished_at: staticStep.finished_at,
      });
      continue;
    }

    const dependencyState = inspectWorkflowNodeDependencies(workingGraph, node);
    if (dependencyState.kind === 'queued') {
      if (queuedStep.error_message !== dependencyState.message) {
        hydratedSteps[stepIndex] = {
          ...queuedStep,
          error_message: dependencyState.message,
        };
        await updateRunStep(supabase, queuedStep.id, {
          error_message: dependencyState.message,
        });
      }
      workingGraph = updateNodeRunState(workingGraph, node.id, {
        status: 'queued',
        error: dependencyState.message,
      });
      continue;
    }

    const startedAt = queuedStep.started_at || new Date().toISOString();

    if (dependencyState.kind === 'blocked') {
      const blockedStep: HydratedRunStep = {
        ...queuedStep,
        status: 'blocked',
        error_message: dependencyState.message,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
      hydratedSteps[stepIndex] = blockedStep;
      workingGraph = applyStepToGraph(workingGraph, blockedStep);
      await updateRunStep(supabase, queuedStep.id, {
        status: blockedStep.status,
        error_message: blockedStep.error_message,
        started_at: blockedStep.started_at,
        finished_at: blockedStep.finished_at,
      });
      continue;
    }

    try {
      const result = await executeWorkflowRunnableNode({
        supabase,
        userId: run.user_id,
        node,
        graph: workingGraph,
        catalogRevision: run.catalog_revision,
        clientRequestKeyHash: workflowGenerationIdempotencyHash(run.id, node.id),
      });

      const resumedStep: HydratedRunStep = {
        ...queuedStep,
        status: result.status,
        generation_id: result.generation_id,
        input_snapshot: result.input_snapshot,
        output_snapshot: result.output_snapshot,
        error_message: result.error_message,
        started_at: startedAt,
        finished_at: result.status === 'processing' || result.status === 'awaiting_approval'
          ? null
          : new Date().toISOString(),
      };

      hydratedSteps[stepIndex] = resumedStep;
      workingGraph = applyStepToGraph(workingGraph, resumedStep);

      await updateRunStep(supabase, queuedStep.id, {
        status: resumedStep.status,
        generation_id: resumedStep.generation_id,
        input_snapshot: resumedStep.input_snapshot,
        output_snapshot: resumedStep.output_snapshot,
        error_message: resumedStep.error_message,
        started_at: resumedStep.started_at,
        finished_at: resumedStep.finished_at,
      });
    } catch (error) {
      const failure = getPublicGenerationStartFailure(error);
      const heldGenerationId = getHeldProviderSubmissionGenerationId(error);

      if (failure.code === 'provider_busy' || failure.code === 'provider_unavailable') {
        // Admission/backpressure is a scheduling condition, not a failed
        // workflow node. Leave the immutable step queued; the durable run job
        // defers without spending an attempt and retries after backoff.
        hydratedSteps[stepIndex] = {
          ...queuedStep,
          error_message: failure.message,
        };
        workingGraph = updateNodeRunState(workingGraph, node.id, {
          status: 'queued',
          error: failure.message,
        });
        await updateRunStep(supabase, queuedStep.id, {
          error_message: failure.message,
        });
        continue;
      }

      if (failure.code === 'submission_pending' && heldGenerationId) {
        // The provider may have accepted the request. The generation start RPC
        // already reserved money and the idempotency key, so link that exact
        // held row instead of retrying and risking a second provider task.
        const processingStep: HydratedRunStep = {
          ...queuedStep,
          status: 'processing',
          generation_id: heldGenerationId,
          output_snapshot: {
            submissionPending: true,
          },
          error_message: failure.message,
          started_at: startedAt,
          finished_at: null,
        };
        hydratedSteps[stepIndex] = processingStep;
        workingGraph = applyStepToGraph(workingGraph, processingStep);
        await updateRunStep(supabase, queuedStep.id, {
          status: processingStep.status,
          generation_id: processingStep.generation_id,
          output_snapshot: processingStep.output_snapshot,
          error_message: processingStep.error_message,
          started_at: processingStep.started_at,
          finished_at: null,
        });
        continue;
      }

      const message = failure.message || (error instanceof Error
        ? error.message
        : 'Node execution failed.');
      const failedStep: HydratedRunStep = {
        ...queuedStep,
        status: 'failed',
        error_message: message,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
      hydratedSteps[stepIndex] = failedStep;
      workingGraph = applyStepToGraph(workingGraph, failedStep);
      await updateRunStep(supabase, queuedStep.id, {
        status: failedStep.status,
        error_message: failedStep.error_message,
        started_at: failedStep.started_at,
        finished_at: failedStep.finished_at,
      });
    }
  }

  const nextRunStatus = deriveWorkflowRunStatus(hydratedSteps);
  const nextFinishedAt = getDerivedRunFinishedAt(run, nextRunStatus, hydratedSteps);
  if (run.status !== nextRunStatus || run.finished_at !== nextFinishedAt) {
    await supabase
      .from('workflow_canvas_runs')
      .update({
        status: nextRunStatus,
        finished_at: nextFinishedAt,
      })
      .eq('id', runId);
  }

  return buildWorkflowRunResponse({
    ...run,
    status: nextRunStatus,
    finished_at: nextFinishedAt,
  }, hydratedSteps);
}

export async function approveWorkflowRunStep(params: {
  supabase: SupabaseClient;
  canvasId: string;
  runId: string;
  stepId: string;
}) {
  const { supabase, canvasId, runId, stepId } = params;
  const { graph, steps } = await loadWorkflowRunState({ supabase, canvasId, runId });
  const step = steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new WorkflowRunApprovalError('Approval step not found.', 404);
  }
  if (step.status !== 'awaiting_approval') {
    throw new WorkflowRunApprovalError('This approval step is not waiting for review.', 409);
  }

  const node = getNodeById(graph, step.node_id);
  if (!node || !isApprovalGateNode(node)) {
    throw new WorkflowRunApprovalError('The selected step is not an approval checkpoint.', 400);
  }

  const outputSnapshot = (step.output_snapshot || {}) as Record<string, unknown>;
  const pendingOutputUrl = typeof outputSnapshot.pendingOutputUrl === 'string'
    ? outputSnapshot.pendingOutputUrl
    : null;
  if (!pendingOutputUrl) {
    throw new WorkflowRunApprovalError('The approval preview is no longer available.', 409);
  }

  const approvedAt = new Date().toISOString();
  await updateRunStep(supabase, step.id, {
    status: 'succeeded',
    output_snapshot: {
      ...outputSnapshot,
      outputUrl: pendingOutputUrl,
      approvedAt,
    },
    error_message: null,
    finished_at: approvedAt,
  });
  await supabase
    .from('workflow_canvas_runs')
    .update({ status: 'processing', finished_at: null })
    .eq('id', runId);

  try {
    await enqueueWorkflowRunStepJob(createServiceClient(), {
      runId,
      // This is a run ticket, not an execution selector. Namespacing prevents
      // collision if the approval gate itself was the original start node.
      nodeId: `approval:${step.node_id}`,
    });
  } catch (error) {
    // No provider work starts here. The stalled-run adopter is the durable
    // fallback if enqueue fails after the approval update commits.
    logBackendError('workflow_approval_enqueue_failed', { error, runId, stepId });
  }

  return getWorkflowRunDetails({ supabase, canvasId, runId });
}

export async function getWorkflowRunDetails(params: {
  supabase: SupabaseClient;
  canvasId: string;
  runId: string;
}) {
  const { supabase, canvasId, runId } = params;
  const { run, steps } = await loadWorkflowRunState({
    supabase,
    canvasId,
    runId,
  });

  // F12: this is a pure read. It used to call advanceWorkflowRunOnce whenever
  // the run was processing, which meant a poll executed nodes, inserted step
  // rows, ran the provider status sync and settled credits -- a GET that both
  // mutated state and made forward progress depend on someone watching.
  // Advancing is the cron worker's job now.
  //
  // syncGenerationState stays false for the same reason: syncGenerationStatuses
  // writes. Reading `generations` as the webhook left it is the accurate view
  // on the normal path; the fallback poll for missed callbacks belongs in the
  // worker, not in every client refresh.
  const hydratedSteps = await hydrateRunSteps({
    steps,
    syncGenerationState: false,
  });

  return buildWorkflowRunResponse(run, hydratedSteps);
}
