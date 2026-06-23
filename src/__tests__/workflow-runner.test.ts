import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type TextInputNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasRunStepRecord,
} from '@/lib/workflow-canvas';

const createServiceClientMock = vi.fn(() => ({ role: 'service' }));
const resolveStoredMediaUrlMock = vi.fn(
  async (_adminClient: unknown, outputUrl: string) =>
    `https://signed.example.com/${encodeURIComponent(outputUrl)}`
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

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => createServiceClientMock(),
  resolveStoredMediaUrl: (...args: Parameters<typeof resolveStoredMediaUrlMock>) =>
    resolveStoredMediaUrlMock(...args),
}));

vi.mock('@/lib/generation-services', () => ({
  startImageGeneration: vi.fn(),
  startMotionGeneration: vi.fn(),
  startSoundEffectGeneration: vi.fn(),
  startVideoGeneration: (...args: Parameters<typeof startVideoGenerationMock>) =>
    startVideoGenerationMock(...args),
  startVoiceoverGeneration: vi.fn(),
  syncGenerationStatuses: (...args: Parameters<typeof syncGenerationStatusesMock>) =>
    syncGenerationStatusesMock(...args),
}));

vi.mock('@/lib/generation-model-catalog', () => ({
  quoteGenerationModel: (...args: Parameters<typeof quoteGenerationModelMock>) =>
    quoteGenerationModelMock(...args),
}));

type RunnerTestState = {
  run: {
    id: string;
    canvas_id: string;
    user_id: string;
    start_node_id: string;
    mode: 'node' | 'branch';
    status: 'processing' | 'succeeded' | 'failed';
    created_at: string;
    finished_at: string | null;
    catalog_revision: string | null;
  };
  graph: WorkflowCanvasGraph;
  steps: WorkflowCanvasRunStepRecord[];
  generations: Array<{
    id: string;
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
        status: 'succeeded',
        output_url: 'generated_images/user-1/hero-frame.png',
      },
    ],
  };
}

function createSupabaseMock(state: RunnerTestState) {
  return {
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
                  filters.get('canvas_id') === state.run.canvas_id;

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
            return {
              async in(column: string, values: string[]) {
                if (column !== 'id') {
                  throw new Error(`Unexpected generations lookup column: ${column}`);
                }

                return {
                  data: values
                    .map((id) => state.generations.find((generation) => generation.id === id))
                    .filter((generation): generation is RunnerTestState['generations'][number] => Boolean(generation))
                    .map((generation) => ({ ...generation })),
                  error: null,
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };
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

  it('advances a processing run so queued downstream nodes resume on poll', async () => {
    const state = createQueuedWorkflowState();
    const supabase = createSupabaseMock(state);
    startVideoGenerationMock.mockResolvedValue({
      predictionId: 'pred-video',
      remainingCredits: 42,
      cost: 30,
      generationId: 'gen-video',
    });

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    const run = await getWorkflowRunDetails({
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
    const supabase = createSupabaseMock(state);

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    await getWorkflowRunDetails({
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

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    await getWorkflowRunDetails({
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

    const { getWorkflowRunDetails } = await import('@/lib/workflow-runner');
    const firstPoll = getWorkflowRunDetails({
      supabase: supabase as never,
      canvasId: state.run.canvas_id,
      runId: state.run.id,
    });
    const secondPoll = getWorkflowRunDetails({
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
