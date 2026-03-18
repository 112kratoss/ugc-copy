import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
  startImageGeneration,
  startMotionGeneration,
  startSoundEffectGeneration,
  startVideoGeneration,
  startVoiceoverGeneration,
  syncGenerationStatuses,
} from '@/lib/generation-services';
import {
  type AudioInputNodeData,
  getExecutionOrder,
  getIncomingEdges,
  getNodeById,
  getNodeOutputUrl,
  isRunnableNode,
  normalizeWorkflowGraph,
  resolveNodeInputs,
  updateNodeRunState,
  type ImageGenerateNodeData,
  type MotionGenerateNodeData,
  type SoundEffectsGenerateNodeData,
  type VideoGenerateNodeData,
  type VoiceoverGenerateNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowCanvasRunStepRecord,
  type WorkflowRunStatus,
} from '@/lib/workflow-canvas';

export interface WorkflowRunExecutionResult {
  runId: string;
  status: 'processing' | 'succeeded' | 'failed';
}

interface RunnableExecutionResult {
  status: 'processing' | 'blocked';
  generation_id: string | null;
  input_snapshot: Record<string, unknown> | null;
  output_snapshot: Record<string, unknown> | null;
  error_message: string | null;
}

interface HydratedRunStep extends WorkflowCanvasRunStepRecord {
  generation_id: string | null;
}

function buildBlockedError(message: string): RunnableExecutionResult {
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

async function persistWorkflowGraph(
  supabase: SupabaseClient,
  canvasId: string,
  graph: WorkflowCanvasGraph
) {
  await supabase
    .from('workflow_canvases')
    .update({ graph, viewport: graph.viewport })
    .eq('id', canvasId);
}

function applyStepToGraph(graph: WorkflowCanvasGraph, step: HydratedRunStep): WorkflowCanvasGraph {
  const outputUrl = (step.output_snapshot as { outputUrl?: string } | null)?.outputUrl || null;

  return updateNodeRunState(graph, step.node_id, {
    status: step.status,
    generationId: step.generation_id,
    outputUrl,
    error: step.error_message,
    updatedAt: step.finished_at || step.started_at,
  });
}

function inspectNodeDependencies(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode
): { kind: 'ready' | 'queued' | 'blocked'; message: string | null } {
  const waitingMessages: string[] = [];
  const blockingMessages: string[] = [];

  for (const edge of getIncomingEdges(graph, node.id)) {
    const source = getNodeById(graph, edge.source);
    if (!source) continue;

    const sourceTitle = source.data.title || source.id;

    if (edge.sourceHandle === 'text') {
      if ('text' in source.data && typeof source.data.text === 'string' && source.data.text.trim()) {
        continue;
      }

      blockingMessages.push(`${sourceTitle} is connected but has no prompt text yet.`);
      continue;
    }

    const outputUrl = getNodeOutputUrl(source);
    if (outputUrl) {
      continue;
    }

    if (isRunnableNode(source)) {
      if (source.data.runState.status === 'processing' || source.data.runState.status === 'queued') {
        waitingMessages.push(`${sourceTitle} is still generating.`);
        continue;
      }

      if (source.data.runState.status === 'failed' || source.data.runState.status === 'blocked') {
        blockingMessages.push(`${sourceTitle} did not finish successfully.`);
        continue;
      }
    }

    const handleLabel = edge.sourceHandle === 'image'
      ? 'image'
      : edge.sourceHandle === 'video'
        ? 'video'
        : edge.sourceHandle === 'audio'
          ? 'audio'
          : 'input';
    blockingMessages.push(`${sourceTitle} has no ${handleLabel} output yet.`);
  }

  if (blockingMessages.length > 0) {
    return { kind: 'blocked', message: blockingMessages[0] };
  }

  if (waitingMessages.length > 0) {
    return { kind: 'queued', message: waitingMessages[0] };
  }

  return { kind: 'ready', message: null };
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

async function executeRunnableNode(params: {
  supabase: SupabaseClient;
  userId: string;
  node: WorkflowCanvasNode;
  graph: WorkflowCanvasGraph;
}): Promise<RunnableExecutionResult> {
  const { supabase, userId, node, graph } = params;
  const inputs = resolveNodeInputs(graph, node.id);

  if (node.type === 'image-generate') {
    if (!inputs.prompt) return buildBlockedError('Image generator is missing a prompt input.');
    const data = node.data as ImageGenerateNodeData;
    const result = await startImageGeneration({
      supabase,
      userId,
      prompt: inputs.prompt,
      model: data.model,
      imageUrls: inputs.imageUrls,
      aspectRatio: data.aspectRatio,
      resolution: data.resolution,
      outputFormat: data.outputFormat,
      googleSearch: data.googleSearch,
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
    if (!inputs.prompt) return buildBlockedError('Video generator is missing a prompt input.');
    const data = node.data as VideoGenerateNodeData;
    const result = await startVideoGeneration({
      supabase,
      userId,
      prompt: inputs.prompt,
      model: data.model,
      imageUrls: inputs.imageUrls,
      mode: data.mode,
      aspectRatio: data.aspectRatio,
      sound: data.sound,
      duration: data.duration,
      resolution: data.resolution,
      fixedLens: data.fixedLens,
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
    const data = node.data as MotionGenerateNodeData;
    const prompt = inputs.prompt || 'Match the reference motion naturally while preserving character consistency.';
    const referenceVideoUrl = inputs.videoUrls[0] || null;
    const characterImageUrl = inputs.imageUrls[0] || null;

    if (!referenceVideoUrl || !characterImageUrl) {
      return buildBlockedError('Motion control requires both an image input and a video input.');
    }

    const result = await startMotionGeneration({
      supabase,
      userId,
      prompt,
      model: data.model,
      referenceVideoUrl,
      characterImageUrl,
      duration: 10,
      characterOrientation: data.characterOrientation,
      mode: data.mode,
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
}): Promise<WorkflowRunExecutionResult> {
  const { supabase, userId, canvasId, graph, startNodeId, mode } = params;
  const executionOrder = getExecutionOrder(graph, startNodeId, mode);

  const runInsert = await supabase
    .from('workflow_canvas_runs')
    .insert({
      canvas_id: canvasId,
      user_id: userId,
      start_node_id: startNodeId,
      mode,
      status: 'processing',
    })
    .select('id')
    .single();

  const runId = runInsert.data?.id as string;
  let workingGraph = normalizeWorkflowGraph(graph);
  let encounteredFailure = false;
  let hasPendingWork = false;

  for (const nodeId of executionOrder) {
    const node = getNodeById(workingGraph, nodeId);
    if (!node) continue;

    const startedAt = new Date().toISOString();

    if (!isRunnableNode(node)) {
      await supabase.from('workflow_canvas_run_steps').insert({
        run_id: runId,
        node_id: node.id,
        status: 'succeeded',
        input_snapshot: resolveNodeInputs(workingGraph, node.id),
        output_snapshot: buildStaticOutputSnapshot(node),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
      continue;
    }

    const dependencyState = inspectNodeDependencies(workingGraph, node);
    if (dependencyState.kind === 'queued') {
      hasPendingWork = true;
      workingGraph = updateNodeRunState(workingGraph, node.id, {
        status: 'queued',
        error: dependencyState.message,
        updatedAt: startedAt,
      });
      await supabase.from('workflow_canvas_run_steps').insert({
        run_id: runId,
        node_id: node.id,
        status: 'queued',
        input_snapshot: resolveNodeInputs(workingGraph, node.id),
        error_message: dependencyState.message,
        started_at: null,
        finished_at: null,
      });
      continue;
    }

    if (dependencyState.kind === 'blocked') {
      encounteredFailure = true;
      workingGraph = updateNodeRunState(workingGraph, node.id, {
        status: 'blocked',
        error: dependencyState.message,
        updatedAt: startedAt,
      });
      await supabase.from('workflow_canvas_run_steps').insert({
        run_id: runId,
        node_id: node.id,
        status: 'blocked',
        input_snapshot: resolveNodeInputs(workingGraph, node.id),
        error_message: dependencyState.message,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
      continue;
    }

    try {
      const result = await executeRunnableNode({ supabase, userId, node, graph: workingGraph });
      const nextRunState: Partial<Record<'status' | 'generationId' | 'error' | 'updatedAt', unknown>> = {
        status: result.status,
        generationId: result.generation_id,
        error: result.error_message,
        updatedAt: result.status === 'processing' ? startedAt : new Date().toISOString(),
      };
      workingGraph = updateNodeRunState(workingGraph, node.id, nextRunState as Record<string, unknown>);

      await supabase.from('workflow_canvas_run_steps').insert({
        run_id: runId,
        node_id: node.id,
        status: result.status,
        generation_id: result.generation_id,
        input_snapshot: result.input_snapshot,
        output_snapshot: result.output_snapshot,
        error_message: result.error_message,
        started_at: startedAt,
        finished_at: result.status === 'processing' ? null : new Date().toISOString(),
      });

      if (result.status === 'blocked') {
        encounteredFailure = true;
      }

      if (result.status === 'processing') {
        hasPendingWork = true;
      }
    } catch (error) {
      encounteredFailure = true;
      const message = error instanceof Error ? error.message : 'Node execution failed.';
      workingGraph = updateNodeRunState(workingGraph, node.id, {
        status: 'failed',
        error: message,
        updatedAt: new Date().toISOString(),
      });
      await supabase.from('workflow_canvas_run_steps').insert({
        run_id: runId,
        node_id: node.id,
        status: 'failed',
        error_message: message,
        input_snapshot: resolveNodeInputs(workingGraph, node.id),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
    }
  }

  await persistWorkflowGraph(supabase, canvasId, workingGraph);

  const nextRunStatus = encounteredFailure ? 'failed' : hasPendingWork ? 'processing' : 'succeeded';
  await supabase
    .from('workflow_canvas_runs')
    .update({
      status: nextRunStatus,
      finished_at: nextRunStatus === 'processing' ? null : new Date().toISOString(),
    })
    .eq('id', runId);

  return {
    runId,
    status: nextRunStatus,
  };
}

export async function getWorkflowRunDetails(params: {
  supabase: SupabaseClient;
  canvasId: string;
  runId: string;
}) {
  const { supabase, canvasId, runId } = params;
  const adminSupabase = createServiceClient();
  const { data: run, error } = await supabase
    .from('workflow_canvas_runs')
    .select('id, canvas_id, user_id, start_node_id, mode, status, created_at, finished_at')
    .eq('canvas_id', canvasId)
    .eq('id', runId)
    .single();

  if (error || !run) {
    throw new Error('Workflow run not found.');
  }

  const { data: canvas } = await supabase
    .from('workflow_canvases')
    .select('graph')
    .eq('id', canvasId)
    .single();

  const { data: steps } = await supabase
    .from('workflow_canvas_run_steps')
    .select('id, node_id, status, generation_id, input_snapshot, output_snapshot, error_message, started_at, finished_at')
    .eq('run_id', runId)
    .order('started_at', { ascending: true });

  const generationIds = (steps || []).map((step) => step.generation_id).filter(Boolean);
  const generationMap = new Map<string, { status: string; output_url: string | null }>();

  if (generationIds.length > 0) {
    await syncGenerationStatuses({
      supabase,
      generationIds: generationIds as string[],
    });

    const { data: generations } = await supabase
      .from('generations')
      .select('id, status, output_url')
      .in('id', generationIds);

    for (const generation of generations || []) {
      generationMap.set(generation.id, {
        status: generation.status,
        output_url: generation.output_url ? await resolveStoredMediaUrl(adminSupabase, generation.output_url) : null,
      });
    }
  }

  const originalSteps = (steps || []) as HydratedRunStep[];
  const hydratedSteps: HydratedRunStep[] = [];

  for (const step of originalSteps) {
    if (!step.generation_id) {
      hydratedSteps.push(step);
      continue;
    }

    const generation = generationMap.get(step.generation_id);
    if (!generation) {
      hydratedSteps.push(step);
      continue;
    }

    const hydratedStatus: WorkflowRunStatus = generation.status === 'processing'
      ? 'processing'
      : generation.status === 'succeeded'
        ? 'succeeded'
        : 'failed';

    const nextStep: HydratedRunStep = {
      ...step,
      status: hydratedStatus,
      output_snapshot: {
        ...(step.output_snapshot as Record<string, unknown> | null),
        outputUrl: generation.output_url,
      },
      finished_at: hydratedStatus === 'processing' ? null : step.finished_at || new Date().toISOString(),
    };

    hydratedSteps.push(nextStep);

    if (
      step.status !== nextStep.status
      || step.finished_at !== nextStep.finished_at
      || JSON.stringify(step.output_snapshot ?? null) !== JSON.stringify(nextStep.output_snapshot ?? null)
    ) {
      await updateRunStep(supabase, step.id, {
        status: nextStep.status,
        output_snapshot: nextStep.output_snapshot,
        finished_at: nextStep.finished_at,
      });
    }
  }

  let workingGraph = normalizeWorkflowGraph(canvas?.graph as WorkflowCanvasGraph | undefined);
  for (const step of hydratedSteps) {
    workingGraph = applyStepToGraph(workingGraph, step);
  }

  const executionOrder = getExecutionOrder(workingGraph, run.start_node_id, run.mode);
  for (const nodeId of executionOrder) {
    const stepIndex = hydratedSteps.findIndex((step) => step.node_id === nodeId);
    if (stepIndex === -1 || hydratedSteps[stepIndex].status !== 'queued') {
      continue;
    }

    const queuedStep = hydratedSteps[stepIndex];
    const node = getNodeById(workingGraph, nodeId);
    if (!node || !isRunnableNode(node)) {
      continue;
    }

    const dependencyState = inspectNodeDependencies(workingGraph, node);
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
      const result = await executeRunnableNode({
        supabase,
        userId: run.user_id,
        node,
        graph: workingGraph,
      });

      const resumedStep: HydratedRunStep = {
        ...queuedStep,
        status: result.status,
        generation_id: result.generation_id,
        input_snapshot: result.input_snapshot,
        output_snapshot: result.output_snapshot,
        error_message: result.error_message,
        started_at: startedAt,
        finished_at: result.status === 'processing' ? null : new Date().toISOString(),
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
      const message = error instanceof Error ? error.message : 'Node execution failed.';
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

  await persistWorkflowGraph(supabase, canvasId, workingGraph);

  const nextRunStatus = hydratedSteps.some((step) => step.status === 'failed' || step.status === 'blocked')
    ? 'failed'
    : hydratedSteps.some((step) => step.status === 'processing' || step.status === 'queued')
      ? 'processing'
      : 'succeeded';

  const nextFinishedAt = nextRunStatus === 'processing' ? null : run.finished_at || new Date().toISOString();
  if (run.status !== nextRunStatus || run.finished_at !== nextFinishedAt) {
    await supabase
      .from('workflow_canvas_runs')
      .update({
        status: nextRunStatus,
        finished_at: nextFinishedAt,
      })
      .eq('id', runId);
  }

  return {
    id: run.id,
    canvas_id: run.canvas_id,
    start_node_id: run.start_node_id,
    mode: run.mode,
    status: nextRunStatus,
    created_at: run.created_at,
    finished_at: nextFinishedAt,
    steps: hydratedSteps,
  };
}
