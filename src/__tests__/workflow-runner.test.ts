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
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import {
  getPublicGenerationStartFailure,
  markHeldProviderSubmission,
} from '@/lib/generation-public-failure';

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
    error_message?: string | null;
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
          select(columns: string) {
            // Like PostgREST, hand back only the columns that were asked for.
            const selected = columns.split(',').map((column) => column.trim());
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
                    .map((generation) => Object.fromEntries(
                      selected.map((column) => [
                        column,
                        (generation as Record<string, unknown>)[column] ?? null,
                      ]),
                    )),
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

// The worker starts a step with a key made from the run and the node, so a
// start it repeats finds the generation its first try reserved. The start
// service raises this when that generation is still active with no provider
// task (`in_progress`), and names it: the step lost its link, not its
// generation.
async function earlierStartStillUnresolved(generationId: string) {
  const { markGenerationStartInProgress } = await import('@/lib/generation-public-failure');
  const { GenerationServiceError } = await import('@/lib/generation-service-core');
  const error = new GenerationServiceError(
    'A generation with this idempotency key is already starting. Retry shortly.',
    409,
  );
  markGenerationStartInProgress(error, generationId);
  return error;
}

/** The worker's record of taking a generation back, as the structured logger wrote it. */
function relinkWarnings(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes('workflow_run_step_relinked_to_earlier_start'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type StepStartService =
  | 'startImageGeneration'
  | 'startVideoGeneration'
  | 'startMotionGeneration'
  | 'startVoiceoverGeneration'
  | 'startSoundEffectGeneration';

// Which start service a step of each kind goes to. A kind added to the canvas
// has to be listed here before the tests typecheck, and a start listed here has
// to be shown to carry the step's request key: without it, every start the
// worker repeats holds the credits again and asks the provider for another
// render. A model run through the catalog has one more start, held to the
// same in `workflow-remote-model.test.ts`.
const STEP_START_SERVICES: Record<WorkflowNodeKind, StepStartService | null> = {
  'text-input': null,
  'image-input': null,
  'video-input': null,
  'audio-input': null,
  'image-generate': 'startImageGeneration',
  'video-generate': 'startVideoGeneration',
  'motion-generate': 'startMotionGeneration',
  'voiceover-generate': 'startVoiceoverGeneration',
  // Refused as blocked until music has a start of its own.
  'music-generate': null,
  'sound-effects-generate': 'startSoundEffectGeneration',
  'approval-gate': null,
  note: null,
  group: null,
};

/** One node of the kind as the canvas makes it, with the inputs it needs to start. */
function createSingleStepGraph(kind: WorkflowNodeKind) {
  const step = createWorkflowNode(kind, { x: 320, y: 40 });
  const prompt = createWorkflowNode('text-input', { x: 40, y: 40 });
  const character = createWorkflowNode('image-input', { x: 40, y: 240 });
  const performance = createWorkflowNode('video-input', { x: 40, y: 440 });
  const graph = normalizeWorkflowGraph(kind === 'motion-generate'
    ? {
        nodes: [
          {
            ...character,
            data: { ...(character.data as ImageInputNodeData), imageUrl: 'https://cdn.example.com/character.png' },
          },
          {
            ...performance,
            data: { ...(performance.data as VideoInputNodeData), videoUrl: 'https://cdn.example.com/reference.mp4' },
          },
          step,
        ],
        edges: [
          createCanvasEdge(character.id, 'image', step.id, 'reference-image'),
          createCanvasEdge(performance.id, 'video', step.id, 'reference-video'),
        ],
      }
    : {
        nodes: [
          { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'A short, clear line.' } },
          step,
        ],
        edges: [createCanvasEdge(prompt.id, 'text', step.id, 'prompt')],
      });

  return { graph, node: graph.nodes.find((node) => node.id === step.id)! };
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

  describe('the request key a step is run with', () => {
    const stepStarts = Object.entries(STEP_START_SERVICES) as Array<[WorkflowNodeKind, StepStartService | null]>;

    /** Runs one node of the kind with a request key, and says what each start service was asked. */
    async function runSingleStep(kind: WorkflowNodeKind) {
      const services = await import('@/lib/generation-services');
      const starts: Record<StepStartService, ReturnType<typeof vi.fn>> = {
        startImageGeneration: vi.mocked(services.startImageGeneration),
        startVideoGeneration: startVideoGenerationMock,
        startMotionGeneration: vi.mocked(services.startMotionGeneration),
        startVoiceoverGeneration: vi.mocked(services.startVoiceoverGeneration),
        startSoundEffectGeneration: vi.mocked(services.startSoundEffectGeneration),
      };
      for (const start of Object.values(starts)) {
        start.mockResolvedValue({ predictionId: 'pred-step', remainingCredits: 42, cost: 7, generationId: 'gen-step' });
      }
      const { graph, node } = createSingleStepGraph(kind);

      const { executeWorkflowRunnableNode } = await import('@/lib/workflow-runner');
      const result = await executeWorkflowRunnableNode({
        supabase: {} as never,
        userId: 'user-1',
        graph,
        node,
        catalogRevision: 'catalog-rev-1',
        clientRequestKeyHash: 'a'.repeat(64),
      });

      return { result, starts };
    }

    it.each(
      stepStarts.filter((entry): entry is [WorkflowNodeKind, StepStartService] => entry[1] !== null),
    )('reaches the %s start', async (kind, startService) => {
      const { result, starts } = await runSingleStep(kind);

      for (const [name, start] of Object.entries(starts)) {
        expect(start, name).toHaveBeenCalledTimes(name === startService ? 1 : 0);
      }
      expect(starts[startService]).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        clientRequestKeyHash: 'a'.repeat(64),
      }));
      expect(result).toMatchObject({ status: 'processing', generation_id: 'gen-step' });
    });

    it.each(
      stepStarts.filter(([, startService]) => startService === null).map(([kind]) => kind),
    )('starts nothing for %s', async (kind) => {
      const { result, starts } = await runSingleStep(kind);

      for (const [name, start] of Object.entries(starts)) {
        expect(start, name).not.toHaveBeenCalled();
      }
      expect(result).toMatchObject({ status: 'blocked', generation_id: null });
    });
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
    // The worker is where a failed step's "Your … failed" push is sent from when
    // the provider callback never arrived, so it must not switch that off.
    expect(syncGenerationStatusesMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ notifyFailures: false }),
    );
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

  it.each([true, false])('links an ambiguous submission without duplicating work (marker confirmed: %s)', async (confirmed) => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    const ambiguous = new Error('provider response timed out');
    markHeldProviderSubmission(ambiguous, 'gen-held-video', { confirmed });
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
      error_message: expect.stringContaining(confirmed ? 'credits stay reserved' : 'current status'),
    });
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('takes back the generation its own earlier start left unresolved', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    startVideoGenerationMock.mockRejectedValueOnce(await earlierStartStillUnresolved('gen-earlier-video'));

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const run = await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    expect(run.status).toBe('processing');
    expect(state.run).toMatchObject({ status: 'processing', finished_at: null });
    // Exactly the step a held submission leaves, so it follows that generation
    // to its callback or to the reaper and says what a held step says. The
    // repeated start's own error would read as "check your inputs".
    const takenBack = {
      status: 'processing',
      generation_id: 'gen-earlier-video',
      output_snapshot: { submissionPending: true },
      error_message: expect.stringMatching(/may still be running.*credits stay reserved/i),
      started_at: expect.any(String),
      finished_at: null,
    };
    expect(run.steps?.find((step) => step.node_id === state.videoNodeId)).toMatchObject(takenBack);
    expect(state.steps.find((step) => step.id === 'step-video')).toMatchObject(takenBack);
    expect(state.steps.find((step) => step.id === 'step-video')?.error_message).not.toMatch(/retry|could not accept/i);
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
    expect(relinkWarnings(warn)).toEqual([expect.objectContaining({
      level: 'warn',
      runId: 'run-1',
      stepId: 'step-video',
      nodeId: state.videoNodeId,
      generationId: 'gen-earlier-video',
    })]);
  });

  it('does not start a step again once it has its generation back', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The earlier start reserved the row before the step lost it, and it is
    // still `pending` when the repeated start finds it.
    state.generations.push({
      id: 'gen-earlier-video',
      user_id: state.run.user_id,
      status: 'pending',
      output_url: null,
    });
    startVideoGenerationMock.mockRejectedValueOnce(await earlierStartStillUnresolved('gen-earlier-video'));

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const advance = () => advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });
    await advance();
    const run = await advance();

    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('processing');
    expect(state.steps.find((step) => step.id === 'step-video')).toMatchObject({
      status: 'processing',
      generation_id: 'gen-earlier-video',
      finished_at: null,
    });
    expect(relinkWarnings(warn)).toHaveLength(1);
  });

  it.each([
    [
      'the key belongs to a generation that already ended without a task',
      { status: 409, message: 'This idempotency key was already used by a failed generation start. Retry with a new key.' },
    ],
    [
      'the catalog the run was quoted against has been replaced',
      { status: 409, code: 'CATALOG_CHANGED', message: 'The model catalog has changed. Refresh settings before generating.' },
    ],
    [
      'the catalog release the run names is gone',
      { status: 409, code: 'CATALOG_CHANGED', message: 'This item was published against a model catalog release that is no longer available.' },
    ],
    [
      'the error only says the same words, and the start service named no generation',
      { status: 409, message: 'A generation with this idempotency key is already starting. Retry shortly.' },
    ],
  ])('still ends a step on a 409 that names no live generation: %s', async (_case, refusal) => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    startVideoGenerationMock.mockRejectedValueOnce(refusal);

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const run = await advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });

    // None of these resolves by waiting, and a step left queued keeps its run
    // `processing` until the 24-hour cap.
    expect(run.status).toBe('failed');
    expect(state.run).toMatchObject({ status: 'failed', finished_at: expect.any(String) });
    expect(state.steps.find((step) => step.id === 'step-video')).toMatchObject({
      status: 'failed',
      generation_id: null,
      finished_at: expect.any(String),
    });
    expect(relinkWarnings(warn)).toEqual([]);
  });

  // The quote turns these away in the catalog's own error class, before any
  // credits are held. Its code for a model that has left the catalog is
  // MODEL_UNAVAILABLE, and the public classifier takes the word "unavailable"
  // for a provider outage: read that way the step stays queued and is tried
  // again on every tick for as long as a busy provider is waited on, though no
  // later tick can find the model, and then ends under the note for an outage.
  // The classifier does end the other two, with the copy for a request the
  // provider refused.
  it.each([
    [
      'its model has left the published catalog',
      { message: 'This model is no longer available.', code: 'MODEL_UNAVAILABLE', status: 409 },
      /no longer available.*choose another model/i,
    ],
    [
      'its model has no published configuration',
      { message: 'This model is not configured for generation.', code: 'MODEL_UNAVAILABLE', status: 409 },
      /no longer available.*choose another model/i,
    ],
    [
      'the catalog has moved on from the revision the run was priced at',
      { message: 'The model catalog has changed. Refresh settings before generating.', code: 'CATALOG_CHANGED', status: 409 },
      /model settings have changed.*reload the page/i,
    ],
    [
      'a setting it uses has been withdrawn',
      { message: 'Some model settings are no longer available.', code: 'INVALID_MODEL_SETTINGS', status: 422 },
      /model settings for this step.*update them/i,
    ],
  ] as const)('ends a step the catalog refuses and says what to change: %s', async (_case, refusal, remedy) => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    // From the module registry the runner loads from: `instanceof` is what the
    // worker tests, and beforeEach has reset the registry.
    const { CatalogError } = await import('@/lib/generation-model-catalog');
    quoteGenerationModelMock.mockImplementationOnce(() => {
      throw new CatalogError(refusal.message, refusal.code, refusal.status);
    });

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const advance = () => advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });
    const run = await advance();

    expect(run.status).toBe('failed');
    expect(state.run).toMatchObject({ status: 'failed', finished_at: expect.any(String) });
    const ended = {
      status: 'failed',
      generation_id: null,
      error_message: expect.stringMatching(remedy),
      started_at: expect.any(String),
      finished_at: expect.any(String),
    };
    expect(run.steps?.find((step) => step.node_id === state.videoNodeId)).toMatchObject(ended);
    expect(state.steps.find((step) => step.id === 'step-video')).toMatchObject(ended);
    // Neither the note a busy provider leaves nor the one for a request the
    // provider refused: the provider was never asked.
    expect(state.steps.find((step) => step.id === 'step-video')?.error_message)
      .not.toMatch(/provider|temporarily|shortly|template inputs/i);
    expect(startVideoGenerationMock).not.toHaveBeenCalled();

    // Nothing is left for a later tick to try.
    await advance();
    expect(quoteGenerationModelMock).toHaveBeenCalledTimes(1);
  });

  it('still waits when the catalog could not be read at all', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    // The database behind the catalog did not answer. That passes, unlike a
    // refusal the catalog made, so the step keeps its place in the queue.
    quoteGenerationModelMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    });

    const { advanceWorkflowRunOnce } = await import('@/lib/workflow-runner');
    const advance = () => advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });
    const run = await advance();

    expect(run.status).toBe('processing');
    expect(state.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(state.steps.find((step) => step.id === 'step-video')).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: expect.stringContaining('temporarily unavailable'),
      finished_at: null,
    });

    // The next tick quotes again, and this time the catalog answers.
    await advance();
    expect(quoteGenerationModelMock).toHaveBeenCalledTimes(2);
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
    expect(state.steps.find((step) => step.id === 'step-video')).toMatchObject({
      status: 'processing',
      generation_id: 'gen-video',
    });
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

// A step reaches its generation through hydrateRunSteps, on every worker tick
// and on every read. A generations row is `pending` until a provider task is
// attached (a held submission stays there), `processing` after that, and
// `waiting` when the status sync finds the task queued at the provider. Only
// `succeeded` and `failed` end it, so only those may end the step: a failed
// step fails the run and blocks everything downstream, and nothing wakes a
// finished run again.
describe('workflow-runner: a step follows its generation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Back to the implementations the mocks were created with: the suite above
    // leaves a start that never resolves behind.
    startVideoGenerationMock.mockReset();
    syncGenerationStatusesMock.mockReset();
  });

  // What the reaper writes on a held row it settles after its 45 minutes.
  const REAPED_MESSAGE = getPublicGenerationStartFailure({
    status: 504,
    message: 'Generation start timed out before a provider task was created.',
  }).message;

  function heldSubmissionNote(confirmed = true) {
    const held = new Error('provider response timed out');
    markHeldProviderSubmission(held, 'gen-held', { confirmed });
    return getPublicGenerationStartFailure(held).message;
  }

  function storedStep(state: RunnerTestState, id: string) {
    const step = state.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`No stored step ${id}`);
    return step;
  }

  /** The image step as the worker's catch leaves it once it has linked a held
   * submission, with the video step waiting on its output. */
  function createHeldImageStepState() {
    const state = createQueuedWorkflowState();
    Object.assign(storedStep(state, 'step-image'), {
      output_snapshot: { submissionPending: true },
      error_message: heldSubmissionNote(),
    });
    Object.assign(state.generations[0], { status: 'pending', output_url: null });
    return state;
  }

  async function loadRunner(state: RunnerTestState) {
    const supabase = createSupabaseMock(state);
    const runner = await import('@/lib/workflow-runner');
    return {
      advance: () => runner.advanceWorkflowRunOnce({
        supabase: supabase as never,
        canvasId: state.run.canvas_id,
        runId: state.run.id,
      }),
      read: () => runner.getWorkflowRunDetails({
        supabase: supabase as never,
        userId: state.run.user_id,
        canvasId: state.run.canvas_id,
        runId: state.run.id,
      }),
    };
  }

  it.each([true, false])(
    'keeps following a held submission on the next tick (marker confirmed: %s)',
    async (confirmed) => {
      const state = createQueuedWorkflowState();
      const ambiguous = new Error('provider response timed out');
      markHeldProviderSubmission(ambiguous, 'gen-held-video', { confirmed });
      // The start RPC reserves the generation before the provider is called, so
      // the held row is already there, still `pending`, when the start throws.
      startVideoGenerationMock.mockImplementationOnce(async () => {
        state.generations.push({
          id: 'gen-held-video',
          user_id: state.run.user_id,
          status: 'pending',
          output_url: null,
        });
        throw ambiguous;
      });
      const { advance } = await loadRunner(state);

      await advance();
      const run = await advance();

      expect(run.status).toBe('processing');
      expect(run.steps.find((step) => step.id === 'step-video')).toMatchObject({
        status: 'processing',
        generation_id: 'gen-held-video',
        finished_at: null,
      });
      expect(state.run).toMatchObject({ status: 'processing', finished_at: null });
      expect(storedStep(state, 'step-video')).toMatchObject({
        status: 'processing',
        generation_id: 'gen-held-video',
        output_snapshot: { submissionPending: true },
        error_message: expect.stringContaining('It may still be running'),
        finished_at: null,
      });
      expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['pending', 'waiting', 'processing'])(
    'reads a %s generation as a step that is still running',
    async (status) => {
      const state = createQueuedWorkflowState();
      Object.assign(state.generations[0], { status, output_url: null });
      const { advance } = await loadRunner(state);

      const run = await advance();

      expect(run.status).toBe('processing');
      expect(state.run).toMatchObject({ status: 'processing', finished_at: null });
      expect(storedStep(state, 'step-image')).toMatchObject({ status: 'processing', finished_at: null });
      // `blocked` is never queued again, so what depends on the step has to wait.
      expect(storedStep(state, 'step-video')).toMatchObject({ status: 'queued', finished_at: null });
      expect(startVideoGenerationMock).not.toHaveBeenCalled();
    },
  );

  it('keeps a step running when the tick finds its task queued at the provider', async () => {
    const state = createQueuedWorkflowState();
    Object.assign(state.generations[0], { status: 'processing', output_url: null });
    // The worker polls the provider before it reads the row, and that sync
    // writes `waiting` for a task the provider reports as waiting or queuing.
    syncGenerationStatusesMock.mockImplementationOnce(async () => {
      state.generations[0].status = 'waiting';
      return undefined;
    });
    const { advance } = await loadRunner(state);

    const run = await advance();

    expect(syncGenerationStatusesMock).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('processing');
    expect(storedStep(state, 'step-image')).toMatchObject({ status: 'processing', finished_at: null });
    expect(storedStep(state, 'step-video')).toMatchObject({ status: 'queued' });
    expect(state.run.status).toBe('processing');
  });

  it('does not end a step on a generation status it does not know', async () => {
    const state = createQueuedWorkflowState();
    // `waiting` was once a status this code had never heard of.
    Object.assign(state.generations[0], { status: 'a-status-added-later', output_url: null });
    const { advance } = await loadRunner(state);

    const run = await advance();

    expect(run.status).toBe('processing');
    expect(storedStep(state, 'step-image')).toMatchObject({ status: 'processing', finished_at: null });
    expect(storedStep(state, 'step-video')).toMatchObject({ status: 'queued' });
  });

  it('fails a step whose generation failed and blocks what depends on it', async () => {
    const state = createQueuedWorkflowState();
    Object.assign(state.generations[0], {
      status: 'failed',
      output_url: null,
      error_message: 'The provider reported a failure.',
    });
    const { advance } = await loadRunner(state);

    const run = await advance();

    expect(run.status).toBe('failed');
    expect(state.run.status).toBe('failed');
    expect(storedStep(state, 'step-image')).toMatchObject({
      status: 'failed',
      // Only a held-submission note is replaced, and this step never had one.
      error_message: null,
    });
    expect(storedStep(state, 'step-video')).toMatchObject({ status: 'blocked' });
    expect(startVideoGenerationMock).not.toHaveBeenCalled();
  });

  it('picks the run back up when a held submission turns out to have succeeded', async () => {
    const state = createHeldImageStepState();
    const { advance, read } = await loadRunner(state);

    const heldRun = await advance();
    expect(heldRun.status).toBe('processing');
    expect(storedStep(state, 'step-image')).toMatchObject({
      status: 'processing',
      error_message: heldSubmissionNote(),
      finished_at: null,
    });
    expect(storedStep(state, 'step-video')).toMatchObject({ status: 'queued' });
    expect(startVideoGenerationMock).not.toHaveBeenCalled();

    // The provider's callback arrives late and the render completes.
    Object.assign(state.generations[0], {
      status: 'succeeded',
      output_url: 'generated_images/user-1/hero-frame.png',
    });

    // A read before the worker's next tick already says so, without writing.
    const seen = (await read()).steps.find((step) => step.id === 'step-image');
    expect(seen).toMatchObject({
      status: 'succeeded',
      error_message: null,
      output_snapshot: {
        outputUrl: 'https://signed.example.com/generated_images%2Fuser-1%2Fhero-frame.png',
      },
    });
    expect(seen?.output_snapshot).not.toHaveProperty('submissionPending');
    expect(storedStep(state, 'step-image').status).toBe('processing');

    const resumedRun = await advance();

    // What the worker stores is what the read showed.
    expect(storedStep(state, 'step-image')).toMatchObject({
      status: 'succeeded',
      error_message: null,
      output_snapshot: seen?.output_snapshot,
    });
    expect(storedStep(state, 'step-image').output_snapshot).not.toHaveProperty('submissionPending');
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
    expect(startVideoGenerationMock).toHaveBeenCalledWith(expect.objectContaining({
      startImageUrl: 'https://signed.example.com/generated_images%2Fuser-1%2Fhero-frame.png',
    }));
    expect(storedStep(state, 'step-video')).toMatchObject({
      status: 'processing',
      generation_id: 'gen-video',
    });
    expect(resumedRun.status).toBe('processing');
    expect(state.run.status).toBe('processing');
  });

  it('fails the step, and says why, once a held submission is settled as failed', async () => {
    const state = createHeldImageStepState();
    const { advance, read } = await loadRunner(state);

    await advance();
    expect(storedStep(state, 'step-image')).toMatchObject({ status: 'processing', finished_at: null });
    expect(state.run.status).toBe('processing');

    // No callback came: the reaper returns the credits and fails the generation.
    Object.assign(state.generations[0], { status: 'failed', error_message: REAPED_MESSAGE });

    const seenRun = await read();
    const seen = seenRun.steps.find((step) => step.id === 'step-image');
    expect(seenRun.status).toBe('failed');
    expect(seen).toMatchObject({ status: 'failed', error_message: REAPED_MESSAGE });
    expect(storedStep(state, 'step-image').status).toBe('processing');

    const run = await advance();

    expect(run.status).toBe('failed');
    expect(state.run.status).toBe('failed');
    // The step no longer says the request may still be running.
    expect(REAPED_MESSAGE).not.toContain('may still be running');
    expect(storedStep(state, 'step-image')).toMatchObject({
      status: 'failed',
      error_message: REAPED_MESSAGE,
      output_snapshot: seen?.output_snapshot,
    });
    expect(storedStep(state, 'step-image').output_snapshot).not.toHaveProperty('submissionPending');
    expect(storedStep(state, 'step-video')).toMatchObject({ status: 'blocked' });
    expect(startVideoGenerationMock).not.toHaveBeenCalled();
  });

  // The same public copy the template worker gives a failed step: a provider's
  // own wording never reaches the step.
  const PUBLIC_FAILURE = getPublicGenerationStartFailure({
    message: 'This generation could not be completed.',
  }).message;

  it.each([
    ['the reason the reaper stored', REAPED_MESSAGE, REAPED_MESSAGE],
    ['a provider’s own wording', 'upstream rejected task 9931 at https://provider.example/tasks/9931', PUBLIC_FAILURE],
    ['no stored reason', null, PUBLIC_FAILURE],
  ])('words a failed held step from %s', async (_source, storedReason, expected) => {
    const state = createHeldImageStepState();
    Object.assign(state.generations[0], { status: 'failed', error_message: storedReason });
    const { advance } = await loadRunner(state);

    await advance();

    expect(storedStep(state, 'step-image')).toMatchObject({ status: 'failed', error_message: expected });
    expect(expected).not.toContain('provider.example');
  });

  it.each([
    [
      'its render succeeds',
      { status: 'succeeded', output_url: 'generated_videos/user-1/late.mp4' },
      { status: 'succeeded', error_message: null },
      'succeeded',
    ],
    [
      'the reaper settles it',
      { status: 'failed', error_message: REAPED_MESSAGE },
      { status: 'failed', error_message: REAPED_MESSAGE },
      'failed',
    ],
  ] as const)('finishes a step that took its earlier generation back when %s', async (_ending, generationEnd, stepEnd, runEnd) => {
    const state = createQueuedWorkflowState();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    state.generations.push({
      id: 'gen-earlier-video',
      user_id: state.run.user_id,
      status: 'pending',
      output_url: null,
    });
    startVideoGenerationMock.mockRejectedValueOnce(await earlierStartStillUnresolved('gen-earlier-video'));
    const { advance } = await loadRunner(state);

    await advance();
    Object.assign(state.generations[1], generationEnd);
    const run = await advance();

    // The same endings as a held step whose link was never lost.
    expect(storedStep(state, 'step-video')).toMatchObject({ ...stepEnd, generation_id: 'gen-earlier-video' });
    expect(storedStep(state, 'step-video').output_snapshot).not.toHaveProperty('submissionPending');
    expect(run.status).toBe(runEnd);
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'waiting'])(
    'shows a step following a %s generation as running to whoever reads the run',
    async (status) => {
      const state = createHeldImageStepState();
      state.generations[0].status = status;
      const stepsBefore = structuredClone(state.steps);
      const { read } = await loadRunner(state);

      const run = await read();

      expect(run.status).toBe('processing');
      expect(run.finished_at).toBeNull();
      expect(run.steps.find((step) => step.id === 'step-image')).toMatchObject({
        status: 'processing',
        error_message: heldSubmissionNote(),
        finished_at: null,
      });
      // Still a pure read.
      expect(state.steps).toEqual(stepsBefore);
      expect(syncGenerationStatusesMock).not.toHaveBeenCalled();
    },
  );
});

// A start the provider, or our own gate in front of it, is too busy for is a
// scheduling condition, so the step stays queued and the run's job brings the
// worker back to start it again. That wait had no end of its own: the only
// limit was the run's 24 hours, and the job comes back every minute. Each try
// that gets as far as the credit hold returns the credits and leaves a failed
// generation in the creator's library. The classifier also reads any error
// that says "unavailable" as an outage, including ones no later try can get
// past.
describe('workflow-runner: a step the provider keeps turning away', () => {
  const MINUTE = 60_000;
  // How long a run's job keeps coming back for an unfinished run.
  const RUN_LIFETIME_MINUTES = 24 * 60;
  const FIRST_REFUSAL = Date.parse('2026-04-01T10:05:00.000Z');
  const BUSY = { status: 429, failureCode: 'provider_busy', message: 'provider capacity is full' };
  const BUSY_NOTE = getPublicGenerationStartFailure(BUSY).message;
  const DOWN = { status: 503, message: 'Service Unavailable' };
  const DOWN_NOTE = getPublicGenerationStartFailure(DOWN).message;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Back to the implementations the mocks were created with.
    startVideoGenerationMock.mockReset();
    syncGenerationStatusesMock.mockReset();
    quoteGenerationModelMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIRST_REFUSAL);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    quoteGenerationModelMock.mockReset();
  });

  const iso = (time: number) => new Date(time).toISOString();

  function videoStep(state: RunnerTestState) {
    const step = state.steps.find((candidate) => candidate.id === 'step-video');
    if (!step) throw new Error('No stored video step');
    return step;
  }

  async function loadRunner(state: RunnerTestState) {
    const supabase = createSupabaseMock(state);
    const runner = await import('@/lib/workflow-runner');
    const advance = () => runner.advanceWorkflowRunOnce({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });
    return {
      advance,
      read: () => runner.getWorkflowRunDetails({
        supabase: supabase as never,
        userId: state.run.user_id,
        canvasId: state.run.canvas_id,
        runId: state.run.id,
      }),
      window: runner.WORKFLOW_RUN_STEP_BUSY_RETRY_WINDOW_MS,
      /** One tick a minute, as the run's job is deferred, until the run ends or its lifetime is up. */
      async tickUntilTheRunEnds() {
        let run = await advance();
        for (let minute = 1; run.status === 'processing' && minute < RUN_LIFETIME_MINUTES; minute += 1) {
          vi.advanceTimersByTime(MINUTE);
          run = await advance();
        }
        return run;
      },
    };
  }

  /** The worker's record of giving a step up, as the structured logger wrote it. */
  function waitEndedWarnings() {
    return vi.mocked(console.warn).mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('workflow_run_step_busy_wait_ended'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('ends a step that is turned away as busy on every tick, once the retry window has passed', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { tickUntilTheRunEnds, window } = await loadRunner(state);

    const run = await tickUntilTheRunEnds();

    // Not still in the queue when the run's own 24 hours run out.
    expect(videoStep(state)).toMatchObject({
      status: 'failed',
      generation_id: null,
      error_message: BUSY_NOTE,
      started_at: expect.any(String),
      finished_at: iso(FIRST_REFUSAL + window),
    });
    expect(run.status).toBe('failed');
    expect(run.steps.find((step) => step.id === 'step-video')).toMatchObject({
      status: 'failed',
      error_message: BUSY_NOTE,
    });
    expect(state.run).toMatchObject({ status: 'failed', finished_at: iso(FIRST_REFUSAL + window) });
  });

  it('stops starting the step: a try a minute for the window and the one that ended it, not one for every minute of the run', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { tickUntilTheRunEnds, advance, window } = await loadRunner(state);

    await tickUntilTheRunEnds();

    expect(startVideoGenerationMock).toHaveBeenCalledTimes(window / MINUTE + 1);

    // Nothing is left for a later tick to try.
    vi.advanceTimersByTime(MINUTE);
    await advance();
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(window / MINUTE + 1);
  });

  it('gives a step thirty minutes, well inside the run’s own lifetime', async () => {
    const { window } = await loadRunner(createQueuedWorkflowState());

    // The time the template worker gives its steps. A change here changes how
    // long a creator waits and how many refused generations a step can leave
    // in their library.
    expect(window).toBe(30 * MINUTE);
    expect(window).toBeLessThan(RUN_LIFETIME_MINUTES * MINUTE);
  });

  it('tries the step for the whole window and gives it up on the first refusal after it', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { advance, window } = await loadRunner(state);

    await advance();
    vi.setSystemTime(FIRST_REFUSAL + window - 1);
    const waiting = await advance();

    expect(waiting.status).toBe('processing');
    expect(state.run).toMatchObject({ status: 'processing', finished_at: null });
    expect(videoStep(state)).toMatchObject({
      status: 'queued',
      generation_id: null,
      error_message: BUSY_NOTE,
      started_at: null,
      finished_at: null,
    });

    vi.setSystemTime(FIRST_REFUSAL + window);
    const ended = await advance();

    expect(ended.status).toBe('failed');
    expect(videoStep(state)).toMatchObject({
      status: 'failed',
      error_message: BUSY_NOTE,
      finished_at: iso(FIRST_REFUSAL + window),
    });
    // The step is tried on the tick that gives it up: only a refusal ends it.
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the time of the first refusal on the step and does not move it on a later one', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { advance, read } = await loadRunner(state);

    await advance();
    expect(videoStep(state).output_snapshot).toEqual({ busySince: iso(FIRST_REFUSAL) });

    // Moved to the latest refusal, the window would never run out.
    vi.advanceTimersByTime(10 * MINUTE);
    await advance();
    expect(videoStep(state).output_snapshot).toEqual({ busySince: iso(FIRST_REFUSAL) });
    expect(videoStep(state)).toMatchObject({ status: 'queued', error_message: BUSY_NOTE });

    // Whoever reads the run sees a step that is waiting, as before.
    const seen = (await read()).steps.find((step) => step.id === 'step-video');
    expect(seen).toMatchObject({ status: 'queued', generation_id: null, error_message: BUSY_NOTE });
  });

  it('starts the step when the provider takes it inside the window, and forgets the wait', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValueOnce(BUSY).mockRejectedValueOnce(BUSY);
    const { advance, window } = await loadRunner(state);

    await advance();
    vi.advanceTimersByTime(MINUTE);
    await advance();
    vi.setSystemTime(FIRST_REFUSAL + window - MINUTE);
    const run = await advance();

    expect(run.status).toBe('processing');
    expect(videoStep(state)).toMatchObject({
      status: 'processing',
      generation_id: 'gen-video',
      error_message: null,
      started_at: iso(FIRST_REFUSAL + window - MINUTE),
      finished_at: null,
    });
    expect(videoStep(state).output_snapshot).toEqual({ predictionId: 'pred-video', cost: 30 });
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(3);
    expect(waitEndedWarnings()).toEqual([]);
  });

  it('does not end the wait on a read: only a refusal the worker meets does', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { advance, read, window } = await loadRunner(state);

    await advance();
    vi.setSystemTime(FIRST_REFUSAL + 2 * window);
    const stepsBefore = structuredClone(state.steps);
    const run = await read();

    expect(run.status).toBe('processing');
    expect(run.steps.find((step) => step.id === 'step-video')).toMatchObject({ status: 'queued' });
    expect(state.steps).toEqual(stepsBefore);
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('gives a step that was already waiting under the busy note a full window from its next refusal', async () => {
    const state = createQueuedWorkflowState();
    // As the worker left it before this limit: a note and no time on the step.
    Object.assign(videoStep(state), { error_message: BUSY_NOTE, output_snapshot: null });
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { advance, window } = await loadRunner(state);

    const run = await advance();

    expect(run.status).toBe('processing');
    expect(videoStep(state)).toMatchObject({
      status: 'queued',
      output_snapshot: { busySince: iso(FIRST_REFUSAL) },
      finished_at: null,
    });

    vi.setSystemTime(FIRST_REFUSAL + window);
    expect((await advance()).status).toBe('failed');
  });

  it('keeps whatever else the step’s snapshot holds while it waits', async () => {
    const state = createQueuedWorkflowState();
    Object.assign(videoStep(state), { output_snapshot: { cost: 30 } });
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { advance } = await loadRunner(state);

    await advance();

    expect(videoStep(state).output_snapshot).toEqual({ cost: 30, busySince: iso(FIRST_REFUSAL) });
  });

  it.each([
    ['is not a time', 'some time yesterday'],
    ['is empty', ''],
    ['is not text', FIRST_REFUSAL - 24 * 60 * MINUTE],
  ])('starts the window from this refusal when the stored start %s', async (_case, storedStart) => {
    const state = createQueuedWorkflowState();
    Object.assign(videoStep(state), { error_message: BUSY_NOTE, output_snapshot: { busySince: storedStart } });
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { advance, window } = await loadRunner(state);

    const run = await advance();

    // Neither given up on sight nor left with a start nothing can be measured from.
    expect(run.status).toBe('processing');
    expect(videoStep(state)).toMatchObject({ status: 'queued', error_message: BUSY_NOTE });
    expect(videoStep(state).output_snapshot).toEqual({ busySince: iso(FIRST_REFUSAL) });

    vi.setSystemTime(FIRST_REFUSAL + window);
    expect((await advance()).status).toBe('failed');
  });

  it('ends a step the provider is down for, with the note for an outage', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValue(DOWN);
    const { tickUntilTheRunEnds, window } = await loadRunner(state);

    const run = await tickUntilTheRunEnds();

    expect(run.status).toBe('failed');
    expect(videoStep(state)).toMatchObject({
      status: 'failed',
      error_message: DOWN_NOTE,
      finished_at: iso(FIRST_REFUSAL + window),
    });
    expect(DOWN_NOTE).toContain('temporarily unavailable');
  });

  // No later try gets past these, and each is read as an outage for the word
  // "unavailable" in its text. They are thrown before any credits are held.
  it.each([
    ['a release with a default it does not list', 'Published web default imagen-4 is unavailable.'],
    ['a catalog revision no release has', 'Generation model catalog revision catalog-rev-1 is unavailable.'],
    ['a price that cannot be worked out', 'Pricing duration is unavailable.'],
  ])('stops asking after the window when the error is one of ours that only says "unavailable": %s', async (_case, message) => {
    const state = createQueuedWorkflowState();
    quoteGenerationModelMock.mockImplementation(() => {
      throw new Error(message);
    });
    const { tickUntilTheRunEnds, window } = await loadRunner(state);

    const run = await tickUntilTheRunEnds();

    expect(run.status).toBe('failed');
    expect(videoStep(state)).toMatchObject({
      status: 'failed',
      generation_id: null,
      error_message: DOWN_NOTE,
      finished_at: iso(FIRST_REFUSAL + window),
    });
    expect(quoteGenerationModelMock).toHaveBeenCalledTimes(window / MINUTE + 1);
    expect(startVideoGenerationMock).not.toHaveBeenCalled();
    // What the error really said is kept for whoever reads the log.
    expect(waitEndedWarnings()).toEqual([expect.objectContaining({ errorMessage: message })]);
  });

  it('measures one window across busy and unavailable refusals, and ends with the last one’s note', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValueOnce(BUSY).mockRejectedValue(DOWN);
    const { advance, window } = await loadRunner(state);

    await advance();
    expect(videoStep(state)).toMatchObject({ status: 'queued', error_message: BUSY_NOTE });

    vi.advanceTimersByTime(MINUTE);
    await advance();
    expect(videoStep(state)).toMatchObject({
      status: 'queued',
      error_message: DOWN_NOTE,
      output_snapshot: { busySince: iso(FIRST_REFUSAL) },
    });

    vi.setSystemTime(FIRST_REFUSAL + window);
    const run = await advance();

    expect(run.status).toBe('failed');
    expect(videoStep(state)).toMatchObject({ status: 'failed', error_message: DOWN_NOTE });
  });

  it('ends the step at once on a refusal that waiting cannot change, whatever is left of the window', async () => {
    const state = createQueuedWorkflowState();
    const refused = { message: 'The request was not accepted.' };
    startVideoGenerationMock.mockRejectedValueOnce(BUSY).mockRejectedValueOnce(refused);
    const { advance } = await loadRunner(state);

    await advance();
    vi.advanceTimersByTime(MINUTE);
    const run = await advance();

    expect(run.status).toBe('failed');
    expect(videoStep(state)).toMatchObject({
      status: 'failed',
      error_message: getPublicGenerationStartFailure(refused).message,
      finished_at: iso(FIRST_REFUSAL + MINUTE),
    });
    // That is not the wait running out, and it is not recorded as one.
    expect(waitEndedWarnings()).toEqual([]);
  });

  // A generation that is still live outranks the clock: the window only ever
  // ends a step that has nothing running for it.
  it('links a submission the provider may have accepted, though the window has passed', async () => {
    const state = createQueuedWorkflowState();
    const ambiguous = new Error('provider response timed out');
    markHeldProviderSubmission(ambiguous, 'gen-held-video');
    startVideoGenerationMock.mockRejectedValueOnce(BUSY).mockRejectedValueOnce(ambiguous);
    const { advance, window } = await loadRunner(state);

    await advance();
    vi.setSystemTime(FIRST_REFUSAL + window);
    const run = await advance();

    expect(run.status).toBe('processing');
    expect(videoStep(state)).toMatchObject({
      status: 'processing',
      generation_id: 'gen-held-video',
      error_message: expect.stringContaining('credits stay reserved'),
      finished_at: null,
    });
    expect(videoStep(state).output_snapshot).toEqual({ submissionPending: true });
  });

  it('takes back the generation its own earlier start left unresolved, though the window has passed', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock
      .mockRejectedValueOnce(BUSY)
      .mockRejectedValueOnce(await earlierStartStillUnresolved('gen-earlier-video'));
    const { advance, window } = await loadRunner(state);

    await advance();
    vi.setSystemTime(FIRST_REFUSAL + window);
    const run = await advance();

    expect(run.status).toBe('processing');
    expect(videoStep(state)).toMatchObject({
      status: 'processing',
      generation_id: 'gen-earlier-video',
      finished_at: null,
    });
    expect(videoStep(state).output_snapshot).toEqual({ submissionPending: true });
  });

  it('still ends a step the catalog refuses at once, in the middle of a wait', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValueOnce(BUSY);
    const { advance } = await loadRunner(state);
    const { CatalogError } = await import('@/lib/generation-model-catalog');

    await advance();
    quoteGenerationModelMock.mockImplementationOnce(() => {
      throw new CatalogError('This model is no longer available.', 'MODEL_UNAVAILABLE', 409);
    });
    vi.advanceTimersByTime(MINUTE);
    const run = await advance();

    expect(run.status).toBe('failed');
    expect(videoStep(state)).toMatchObject({
      status: 'failed',
      error_message: expect.stringMatching(/no longer available.*choose another model/i),
    });
    expect(startVideoGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('records that it gave the step up, with when the wait began and what the last refusal said', async () => {
    const state = createQueuedWorkflowState();
    startVideoGenerationMock.mockRejectedValue(BUSY);
    const { advance, window } = await loadRunner(state);

    await advance();
    vi.advanceTimersByTime(MINUTE);
    await advance();
    expect(waitEndedWarnings()).toEqual([]);

    vi.setSystemTime(FIRST_REFUSAL + window + MINUTE);
    await advance();

    expect(waitEndedWarnings()).toEqual([expect.objectContaining({
      level: 'warn',
      runId: 'run-1',
      stepId: 'step-video',
      nodeId: state.videoNodeId,
      failureCode: 'provider_busy',
      busySince: iso(FIRST_REFUSAL),
      waitedMs: window + MINUTE,
      errorMessage: 'provider capacity is full',
    })]);
  });
});
