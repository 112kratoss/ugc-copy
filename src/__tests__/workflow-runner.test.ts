import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ApprovalGateNodeData,
  createCanvasEdge,
  createWorkflowNode,
  type ImageInputNodeData,
  normalizeWorkflowGraph,
  type TextInputNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasRunStepRecord,
} from '@/lib/workflow-canvas';
import { markHeldProviderSubmission } from '@/lib/generation-public-failure';

// The runner reads generations service-role (authenticated grants stop at the
// resume projection), so the service client must serve the same state-backed
// tables as the user client. Capture the latest built mock and hand it out.
const lastSupabaseMockRef: { current: unknown } = { current: null };
const createServiceClientMock = vi.fn(() => lastSupabaseMockRef.current ?? { role: 'service' });
const resolveOwnedStoredMediaUrlMock = vi.fn(
  async (_adminClient: unknown, outputUrl: string, ownerUserId: string) =>
    outputUrl.split('/')[1] === ownerUserId
      ? `https://signed.example.com/${encodeURIComponent(outputUrl)}`
      : null
);
const quoteGenerationModelMock = vi.fn((input: { modelId: string; catalogRevision?: string | null }) => ({
  modelId: input.modelId,
  catalogRevision: input.catalogRevision ?? 'current-revision',
  normalizedSettings: {},
  costCredits: 77,
}));
type StartVideoGenerationResult = {
  predictionId: string;
  remainingCredits: number;
  cost: number;
  generationId: string;
};
type ResolveVideoStart = (value: StartVideoGenerationResult) => void;
const startVideoGenerationMock = vi.fn(async (..._args: unknown[]): Promise<StartVideoGenerationResult> => {
  void _args;
  return {
    predictionId: 'pred-video',
    remainingCredits: 42,
    cost: 30,
    generationId: 'gen-video',
  };
});
const syncGenerationStatusesMock = vi.fn(async () => undefined);
const enqueueWorkflowRunStepJobMock = vi.fn(async (..._args: unknown[]) => {
  void _args;
  return 'approval-job-1';
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => createServiceClientMock(),
  resolveOwnedStoredMediaUrl: (...args: Parameters<typeof resolveOwnedStoredMediaUrlMock>) =>
    resolveOwnedStoredMediaUrlMock(...args),
}));

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: (...args: unknown[]) =>
    (syncGenerationStatusesMock as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/generation-services', () => ({
  startImageGeneration: vi.fn(),
  startMotionGeneration: vi.fn(),
  startSoundEffectGeneration: vi.fn(),
  startVideoGeneration: (...args: Parameters<typeof startVideoGenerationMock>) =>
    startVideoGenerationMock(...args),
  startVoiceoverGeneration: vi.fn(),
}));

vi.mock('@/lib/generation-model-catalog-store', () => ({
  quotePublishedGenerationModel: (input: Parameters<typeof quoteGenerationModelMock>[0]) =>
    quoteGenerationModelMock(input),
}));

vi.mock('@/lib/workflow-run-jobs', () => ({
  enqueueWorkflowRunStepJob: (...args: unknown[]) => enqueueWorkflowRunStepJobMock(...args),
}));

type RunnerTestState = {
  run: {
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
  };
  graph: WorkflowCanvasGraph;
  steps: WorkflowCanvasRunStepRecord[];
  generations: Array<{
    id: string;
    user_id: string;
    status: string;
    output_url: string | null;
  }>;
};

function createQueuedWorkflowState(): RunnerTestState & {
  imageNodeId: string;
  videoNodeId: string;
} {
  const promptNode = createWorkflowNode('text-input', { x: 40, y: 40 });
  const imageNode = createWorkflowNode('image-generate', { x: 280, y: 40 });
  const videoNode = createWorkflowNode('video-generate', { x: 520, y: 40 });
  const graph = normalizeWorkflowGraph({
    nodes: [
      {
        ...promptNode,
        data: {
          ...(promptNode.data as TextInputNodeData),
          text: 'Launch video prompt',
        },
      },
      imageNode,
      videoNode,
    ],
    edges: [
      createCanvasEdge(promptNode.id, 'text', imageNode.id, 'prompt'),
      createCanvasEdge(promptNode.id, 'text', videoNode.id, 'prompt'),
      createCanvasEdge(imageNode.id, 'image', videoNode.id, 'start-frame'),
    ],
  });

  return {
    imageNodeId: imageNode.id,
    videoNodeId: videoNode.id,
    run: {
      id: 'run-1',
      canvas_id: 'canvas-1',
      user_id: 'user-1',
      start_node_id: imageNode.id,
      mode: 'branch',
      status: 'processing',
      created_at: '2026-04-01T10:00:00.000Z',
      finished_at: null,
      catalog_revision: 'catalog-rev-1',
      graph_snapshot: normalizeWorkflowGraph(graph),
    },
    graph,
    steps: [
      {
        id: 'step-image',
        node_id: imageNode.id,
        status: 'processing',
        generation_id: 'gen-image',
        input_snapshot: {
          prompt: 'Launch video prompt',
        },
        output_snapshot: {
          predictionId: 'pred-image',
        },
        error_message: null,
        started_at: '2026-04-01T10:00:00.000Z',
        finished_at: null,
      },
      {
        id: 'step-video',
        node_id: videoNode.id,
        status: 'queued',
        generation_id: null,
        input_snapshot: {
          prompt: 'Launch video prompt',
        },
        output_snapshot: null,
        error_message: 'Waiting for upstream image output.',
        started_at: null,
        finished_at: null,
      },
    ],
    generations: [
      {
        id: 'gen-image',
        user_id: 'user-1',
        status: 'succeeded',
        output_url: 'generated_images/user-1/hero-frame.png',
      },
    ],
  };
}

function createAwaitingApprovalState(): RunnerTestState & {
  approvalNodeId: string;
  videoNodeId: string;
} {
  const promptNode = createWorkflowNode('text-input', { x: 40, y: 40 });
  const imageNode = createWorkflowNode('image-input', { x: 40, y: 240 });
  const approvalNode = createWorkflowNode('approval-gate', { x: 300, y: 240 });
  const videoNode = createWorkflowNode('video-generate', { x: 560, y: 120 });
  const graph = normalizeWorkflowGraph({
    nodes: [
      {
        ...promptNode,
        data: { ...(promptNode.data as TextInputNodeData), text: 'Approved frame video' },
      },
      {
        ...imageNode,
        data: {
          ...(imageNode.data as ImageInputNodeData),
          imageUrl: 'uploads/user-1/review-frame.png',
          storagePath: 'uploads/user-1/review-frame.png',
        },
      },
      {
        ...approvalNode,
        data: {
          ...(approvalNode.data as ApprovalGateNodeData),
          mediaKind: 'image',
          label: 'Review opening frame',
        },
      },
      videoNode,
    ],
    edges: [
      createCanvasEdge(promptNode.id, 'text', videoNode.id, 'prompt'),
      createCanvasEdge(imageNode.id, 'image', approvalNode.id, 'image'),
      createCanvasEdge(approvalNode.id, 'image', videoNode.id, 'start-frame'),
    ],
  });

  return {
    approvalNodeId: approvalNode.id,
    videoNodeId: videoNode.id,
    run: {
      id: 'run-approval',
      canvas_id: 'canvas-approval',
      user_id: 'user-1',
      start_node_id: imageNode.id,
      mode: 'branch',
      status: 'awaiting_approval',
      created_at: '2026-04-01T10:00:00.000Z',
      finished_at: null,
      catalog_revision: 'catalog-rev-1',
      graph_snapshot: normalizeWorkflowGraph(graph),
    },
    graph,
    steps: [
      {
        id: 'step-input',
        node_id: imageNode.id,
        status: 'succeeded',
        generation_id: null,
        input_snapshot: null,
        output_snapshot: { outputUrl: 'uploads/user-1/review-frame.png' },
        error_message: null,
        started_at: '2026-04-01T10:00:00.000Z',
        finished_at: '2026-04-01T10:00:00.000Z',
      },
      {
        id: 'step-approval',
        node_id: approvalNode.id,
        status: 'awaiting_approval',
        generation_id: null,
        input_snapshot: null,
        output_snapshot: {
          pendingOutputUrl: 'uploads/user-1/review-frame.png',
          mediaKind: 'image',
          label: 'Review opening frame',
        },
        error_message: null,
        started_at: '2026-04-01T10:00:01.000Z',
        finished_at: null,
      },
      {
        id: 'step-video',
        node_id: videoNode.id,
        status: 'queued',
        generation_id: null,
        input_snapshot: null,
        output_snapshot: null,
        error_message: 'Waiting for approval.',
        started_at: null,
        finished_at: null,
      },
    ],
    generations: [],
  };
}

function createSupabaseMock(state: RunnerTestState) {
  const mock = {
    from(table: string) {
      if (table === 'workflow_canvas_runs') {
        return {
          select() {
            const filters = new Map<string, unknown>();
            const query = {
              eq(column: string, value: unknown) {
                filters.set(column, value);
                return query;
              },
              async single() {
                const matchesRun =
                  filters.get('id') === state.run.id &&
                  filters.get('canvas_id') === state.run.canvas_id &&
                  (!filters.has('user_id') || filters.get('user_id') === state.run.user_id);

                return matchesRun
                  ? { data: { ...state.run }, error: null }
                  : { data: null, error: { message: 'Workflow run not found.' } };
              },
            };

            return query;
          },
          update(updates: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                if (column === 'id' && value === state.run.id) {
                  Object.assign(state.run, updates);
                }

                return this;
              },
            };
          },
        };
      }

      if (table === 'workflow_canvases') {
        return {
          select() {
            const filters = new Map<string, unknown>();
            const query = {
              eq(column: string, value: unknown) {
                filters.set(column, value);
                return query;
              },
              async single() {
                const matchesCanvas = filters.get('id') === state.run.canvas_id;
                return matchesCanvas
                  ? { data: { graph: state.graph }, error: null }
                  : { data: null, error: { message: 'Workflow canvas not found.' } };
              },
            };

            return query;
          },
          update(updates: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                if (column === 'id' && value === state.run.canvas_id) {
                  if (updates.graph) {
                    state.graph = updates.graph as WorkflowCanvasGraph;
                  }
                }

                return this;
              },
            };
          },
        };
      }

      if (table === 'workflow_canvas_run_steps') {
        return {
          select() {
            const filters = new Map<string, unknown>();
            const query = {
              eq(column: string, value: unknown) {
                filters.set(column, value);
                return query;
              },
              async order() {
                const matchesRun = filters.get('run_id') === state.run.id;
                return {
                  data: matchesRun ? state.steps.map((step) => ({ ...step })) : [],
                  error: null,
                };
              },
            };

            return query;
          },
          update(updates: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                if (column === 'id') {
                  const step = state.steps.find((current) => current.id === value);
                  if (step) {
                    Object.assign(step, updates);
                  }
                }

                return this;
              },
            };
          },
        };
      }

      if (table === 'generations') {
        return {
          select() {
            const filters = new Map<string, unknown>();
            const query = {
              eq(column: string, value: unknown) {
                filters.set(column, value);
                return query;
              },
              async in(column: string, values: string[]) {
                if (column !== 'id') {
                  throw new Error(`Unexpected generations lookup column: ${column}`);
                }

                return {
                  data: values
                    .map((id) => state.generations.find((generation) => generation.id === id))
                    .filter((generation): generation is RunnerTestState['generations'][number] => Boolean(generation))
                    .filter((generation) => (
                      !filters.has('user_id') || filters.get('user_id') === generation.user_id
                    ))
                    .map((generation) => ({ ...generation })),
                  error: null,
                };
              },
            };

            return query;
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };

  lastSupabaseMockRef.current = mock;
  return mock;
}

describe('workflow-runner recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    quoteGenerationModelMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts private template video steps without counting start/end frames as generic references', async () => {
    const prompt = createWorkflowNode('text-input', { x: 0, y: 0 });
    const start = createWorkflowNode('image-input', { x: 0, y: 160 });
    const end = createWorkflowNode('image-input', { x: 0, y: 320 });
    const video = createWorkflowNode('video-generate', { x: 320, y: 120 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        {
          ...prompt,
          data: { ...(prompt.data as TextInputNodeData), text: 'Transform smoothly.' },
        },
        {
          ...start,
          data: {
            ...(start.data as ImageInputNodeData),
            imageUrl: 'https://signed.example/start.png',
            storagePath: 'template_inputs/user/run/final/start.png',
          },
        },
        {
          ...end,
          data: {
            ...(end.data as ImageInputNodeData),
            imageUrl: 'https://signed.example/end.png',
            storagePath: 'template_inputs/user/run/final/end.png',
          },
        },
        video,
      ],
      edges: [
        createCanvasEdge(prompt.id, 'text', video.id, 'prompt'),
        createCanvasEdge(start.id, 'image', video.id, 'start-frame'),
        createCanvasEdge(end.id, 'image', video.id, 'end-frame'),
      ],
    });

    const { executeWorkflowRunnableNode } = await import('@/lib/workflow-runner');
    await executeWorkflowRunnableNode({
      supabase: {} as never,
      userId: 'user-1',
      graph,
      node: graph.nodes.find((node) => node.id === video.id)!,
      catalogRevision: 'catalog-rev-1',
      clientRequestKeyHash: 'a'.repeat(64),
      persistInputMedia: false,
      privateRecipe: true,
      templateContext: { runId: 'run-1', stepId: 'step-1' },
    });

    expect(quoteGenerationModelMock).toHaveBeenCalledWith(expect.objectContaining({
      inputCounts: expect.objectContaining({ images: 0 }),
    }));
    expect(startVideoGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      startImageUrl: 'https://signed.example/start.png',
      endImageUrl: 'https://signed.example/end.png',
      persistInputMedia: false,
      privateRecipe: true,
      templateContext: { runId: 'run-1', stepId: 'step-1' },
      clientRequestKeyHash: 'a'.repeat(64),
    }));
  });

  // F12 moved advancing off the read path. These tests exercise the runner's
  // advance logic, so they drive advanceWorkflowRunOnce directly -- which is
  // what the durable queue worker calls. The pure-read contract of
  // getWorkflowRunDetails is pinned separately below.
  it('advances a processing run so queued downstream nodes resume when the worker claims it', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    startVideoGenerationMock.mockResolvedValue({
      predictionId: 'pred-video',
      remainingCredits: 42,
      cost: 30,
      generationId: 'gen-video',
    });

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const run = await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(syncGenerationStatusesMock).toHaveBeenCalledTimes(1);
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
    expect(startVideoGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Launch video prompt',
        startImageUrl: 'https://signed.example.com/generated_images%2Fuser-1%2Fhero-frame.png',
      })
    );
    expect(run.status).toBe('processing');
    expect(run.steps?.find((step) => step.node_id === state.imageNodeId)).toMatchObject({
      status: 'succeeded',
      generation_id: 'gen-image',
    });
    expect(run.steps?.find((step) => step.node_id === state.videoNodeId)).toMatchObject({
      status: 'processing',
      generation_id: 'gen-video',
    });
    expect(state.graph.nodes.find((node) => node.id === state.videoNodeId)?.data.runState.status).toBe('idle');
  });

  it('keeps provider admission backpressure queued for a durable retry', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    startVideoGenerationMock.mockRejectedValueOnce({
      status: 429,
      failureCode: 'provider_busy',
      message: 'provider capacity is full',
    });

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const run = await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(run.status).toBe('processing');
    expect(run.steps?.find((step) => step.node_id === state.videoNodeId)).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: expect.stringContaining('busy'),
    });
    expect(state.run.status).toBe('processing');
  });

  it('links an ambiguous held submission instead of starting a duplicate provider task', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    const ambiguous = new Error('provider response timed out');
    markHeldProviderSubmission(ambiguous, 'gen-held-video');
    startVideoGenerationMock.mockRejectedValueOnce(ambiguous);

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const run = await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(run.status).toBe('processing');
    expect(run.steps?.find((step) => step.node_id === state.videoNodeId)).toMatchObject({
      status: 'processing',
      generation_id: 'gen-held-video',
      output_snapshot: { submissionPending: true },
      error_message: expect.stringContaining('credits stay reserved'),
    });
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('continues from the immutable run snapshot when the source canvas changes', async () => {
    const state = createQueuedWorkflowState();
    state.graph = normalizeWorkflowGraph({
      ...state.graph,
      nodes: state.graph.nodes.map((node) => node.type === 'text-input'
        ? {
            ...node,
            data: {
              ...(node.data as TextInputNodeData),
              text: 'Edited canvas prompt that must not affect the active run',
            },
          }
        : node),
    });
    const supabase = createSupabaseMock(state);

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(startVideoGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Launch video prompt',
    }));
  });

  it('passes connected Kling video references as named video elements when a queued video node resumes', async () => {
    const state = createQueuedWorkflowState();
    const referenceVideo = createWorkflowNode('video-input', { x: 260, y: 220 });
    state.graph = normalizeWorkflowGraph({
      ...state.graph,
      nodes: [
        ...state.graph.nodes.map((node) => {
          if (node.id !== state.videoNodeId) return node;
          const videoData = node.data as VideoGenerateNodeData;
          return {
            ...node,
            data: {
              ...videoData,
              model: 'kling-3.0-video' as VideoGenerateNodeData['model'],
            } satisfies VideoGenerateNodeData,
          };
        }),
        {
          ...referenceVideo,
          data: {
            ...(referenceVideo.data as VideoInputNodeData),
            title: 'Motion ref',
            videoUrl: 'uploads/user-1/motion-ref.mp4',
            storagePath: 'uploads/user-1/motion-ref.mp4',
          } satisfies VideoInputNodeData,
        },
      ],
      edges: [
        ...state.graph.edges,
        createCanvasEdge(referenceVideo.id, 'video', state.videoNodeId, 'reference-video'),
      ],
    });
    state.run.graph_snapshot = normalizeWorkflowGraph(state.graph);
    const supabase = createSupabaseMock(state);

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(startVideoGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'kling-3.0-video',
        klingVideoElements: [
          expect.objectContaining({
            url: 'uploads/user-1/motion-ref.mp4',
            handle: '@motion_ref',
            displayName: 'Motion ref',
            storagePath: 'uploads/user-1/motion-ref.mp4',
          }),
        ],
      })
    );
  });

  it('quotes queued media nodes with the workflow run catalog revision before charging', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(quoteGenerationModelMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      modelId: 'kling-3.0-video',
      catalogRevision: 'catalog-rev-1',
    }));
    expect(startVideoGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      quotedCostCredits: 77,
    }));
  });

  it('reads a processing run without advancing it, charging it, or syncing the provider', async () => {
    // F12: getWorkflowRunDetails used to call advanceWorkflowRunOnce whenever
    // the run was processing, so polling a run executed nodes, inserted steps,
    // ran the provider status sync and settled credits. A client refresh could
    // therefore start paid work, and forward progress depended on someone
    // watching. Advancing belongs to the durable queue worker now.
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    const stepsBefore = JSON.parse(JSON.stringify(state.steps));
    const runStatusBefore = state.run.status;

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    const run = await getWorkflowRunDetails({
      supabase: supabase as never,
      userId: state.run.user_id,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(startVideoGenerationMock).not.toHaveBeenCalled();
    expect(quoteGenerationModelMock).not.toHaveBeenCalled();
    // syncGenerationStatuses writes -- it polls the provider and settles
    // credits -- so a pure read must not reach it.
    expect(syncGenerationStatusesMock).not.toHaveBeenCalled();
    expect(state.steps).toEqual(stepsBefore);
    expect(state.run.status).toBe(runStatusBefore);
    // It still has to be a useful read: the queued node is reported as queued
    // rather than omitted.
    expect(run.steps?.find((step) => step.node_id === state.videoNodeId)).toMatchObject({
      status: 'queued',
    });
  });

  it('never hydrates or signs a generation owned by someone other than the run owner', async () => {
    const state = createQueuedWorkflowState();
    state.generations[0].user_id = 'user-2';
    state.generations[0].output_url = 'generated_images/user-2/private-frame.png';
    const supabase = createSupabaseMock(state);

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    const run = await getWorkflowRunDetails({
      supabase: supabase as never,
      userId: state.run.user_id,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(resolveOwnedStoredMediaUrlMock).not.toHaveBeenCalled();
    expect(syncGenerationStatusesMock).not.toHaveBeenCalled();
    expect(run.steps.find((step) => step.id === 'step-image')).toMatchObject({
      status: 'processing',
      generation_id: 'gen-image',
      output_snapshot: { predictionId: 'pred-image' },
    });
  });

  it('never sends a foreign step generation through privileged provider synchronization', async () => {
    const state = createQueuedWorkflowState();
    state.generations[0].user_id = 'user-2';
    state.generations[0].output_url = 'generated_images/user-2/private-frame.png';
    const supabase = createSupabaseMock(state);

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const run = await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(syncGenerationStatusesMock).not.toHaveBeenCalled();
    expect(resolveOwnedStoredMediaUrlMock).not.toHaveBeenCalled();
    expect(startVideoGenerationMock).not.toHaveBeenCalled();
    expect(run.status).toBe('processing');
  });

  it('does not sign a corrupted owned generation path under another owner prefix', async () => {
    const state = createQueuedWorkflowState();
    state.generations[0].output_url = 'generated_images/user-2/private-frame.png';
    const supabase = createSupabaseMock(state);

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    const run = await getWorkflowRunDetails({
      supabase: supabase as never,
      userId: state.run.user_id,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(resolveOwnedStoredMediaUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      'generated_images/user-2/private-frame.png',
      'user-1',
    );
    expect(run.steps.find((step) => step.id === 'step-image')?.output_snapshot).toMatchObject({
      outputUrl: null,
    });
  });

  it('fails closed before hydration when the owner-scoped run lookup does not match', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    await expect(getWorkflowRunDetails({
      supabase: supabase as never,
      userId: 'user-2',
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    })).rejects.toThrow('Workflow run not found.');

    expect(resolveOwnedStoredMediaUrlMock).not.toHaveBeenCalled();
  });

  it('approves a checkpoint and durably queues its downstream branch', async () => {
    const state = createAwaitingApprovalState();
    const supabase = createSupabaseMock(state);

    const { approveWorkflowRunStep } = await import('@/lib/workflow-runner');
    const run = await approveWorkflowRunStep({
      ownerSupabase: supabase as never,
      mutationSupabase: supabase as never,
      userId: state.run.user_id,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
      stepId: 'step-approval',
    });

    expect(state.steps.find((step) => step.id === 'step-approval')).toMatchObject({
      status: 'succeeded',
      output_snapshot: expect.objectContaining({
        outputUrl: 'uploads/user-1/review-frame.png',
      }),
    });
    expect(startVideoGenerationMock).not.toHaveBeenCalled();
    expect(enqueueWorkflowRunStepJobMock).toHaveBeenCalledWith(expect.anything(), {
      runId: state.run.id,
      nodeId: `approval:${state.approvalNodeId}`,
    });
    expect(run.steps?.find((step) => step.node_id === state.videoNodeId)).toMatchObject({
      status: 'queued',
    });
  });

  it('does not cross the service mutation boundary when the run owner check fails', async () => {
    const state = createAwaitingApprovalState();
    const supabase = createSupabaseMock(state);
    const stepBefore = structuredClone(state.steps.find((step) => step.id === 'step-approval'));

    const { approveWorkflowRunStep } = await import('@/lib/workflow-runner');
    await expect(approveWorkflowRunStep({
      ownerSupabase: supabase as never,
      mutationSupabase: supabase as never,
      userId: 'user-2',
      canvasId: state.run.canvas_id,
      runId: state.run.id,
      stepId: 'step-approval',
    })).rejects.toThrow('Workflow run not found.');

    expect(state.steps.find((step) => step.id === 'step-approval')).toEqual(stepBefore);
    expect(enqueueWorkflowRunStepJobMock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent recovery polls for the same run', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    let resolveVideoStart: ResolveVideoStart | null = null;

    startVideoGenerationMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVideoStart = resolve;
        })
    );

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const firstPoll = advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });
    const secondPoll = advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    await vi.waitFor(() => {
      expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
    });

    const finishVideoStart = resolveVideoStart as unknown as ResolveVideoStart;
    expect(finishVideoStart).toBeTruthy();
    finishVideoStart({
      predictionId: 'pred-video',
      remainingCredits: 42,
      cost: 30,
      generationId: 'gen-video',
    });

    const [firstRun, secondRun] = await Promise.all([firstPoll, secondPoll]);
    expect(syncGenerationStatusesMock).toHaveBeenCalledTimes(1);
    expect(firstRun).toEqual(secondRun);
  });
});
