import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planWorkflowStepPrice, useWorkflowRunPrices } from '@/app/create-workflow/useWorkflowRunPrices';
import { formatWorkflowRunPrice } from '@/app/create-workflow/workflowCanvasUiUtils';
import {
  createCanvasEdge,
  createStarterGraph,
  createWorkflowNode,
  getExecutionOrder,
  type VideoGenerateNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
} from '@/lib/workflow-canvas';

function nodeOfType(graph: WorkflowCanvasGraph, type: WorkflowCanvasNode['type']) {
  const node = graph.nodes.find((candidate) => candidate.type === type);
  expect(node, type).toBeTruthy();
  return node!;
}

function quotePosts() {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/generation-models/quote');
}

// Image 4, video 30, motion 3 a second: enough to tell the steps apart in a total.
function priceFor(body: { kind: string; settings?: { duration?: number } }) {
  if (body.kind === 'image') return 4;
  if (body.kind === 'video') return 30;
  return 3 * Number(body.settings?.duration ?? 0);
}

describe('planWorkflowStepPrice', () => {
  it('quotes each generate step the way the runner does, and nothing for inputs', () => {
    const graph = createStarterGraph();
    const video = nodeOfType(graph, 'video-generate');
    const videoSeconds = (video.data as VideoGenerateNodeData).duration;

    expect(planWorkflowStepPrice(graph, nodeOfType(graph, 'text-input'))).toEqual({ kind: 'free' });
    expect(planWorkflowStepPrice(graph, nodeOfType(graph, 'image-input'))).toEqual({ kind: 'free' });
    expect(planWorkflowStepPrice(graph, nodeOfType(graph, 'image-generate'))).toMatchObject({
      kind: 'quote',
      approximate: false,
      input: { kind: 'image', inputCounts: { images: 0, videos: 0, audios: 0 } },
    });
    // The image input is the video's start frame, not one of its references.
    expect(planWorkflowStepPrice(graph, video)).toMatchObject({
      kind: 'quote',
      input: { kind: 'video', settings: { duration: videoSeconds }, inputCounts: { images: 0, videos: 0, audios: 0 } },
    });
    // The motion step is charged for the clip the video step will make.
    expect(planWorkflowStepPrice(graph, nodeOfType(graph, 'motion-generate'))).toMatchObject({
      kind: 'quote',
      approximate: true,
      input: { kind: 'motion', modelId: 'kling-3.0', settings: { resolution: '720p', duration: videoSeconds }, inputCounts: { images: 1, videos: 1 } },
    });
  });

  it('prices a multi-shot video by its shots and a motion step by an uploaded clip’s length', () => {
    const graph = createStarterGraph();
    const video = nodeOfType(graph, 'video-generate');
    video.data = {
      ...video.data,
      isMultiShot: true,
      multiPrompts: [
        { id: 'shot-1', prompt: 'One', duration: 3.4 },
        { id: 'shot-2', prompt: 'Two', duration: 4.6 },
      ],
    } as VideoGenerateNodeData;
    expect(planWorkflowStepPrice(graph, video)).toMatchObject({ input: { settings: { duration: 8, isMultiShot: true } } });

    const clip = createWorkflowNode('video-input', { x: 0, y: 0 });
    clip.data = { ...clip.data, videoUrl: 'https://cdn.example/clip.mp4', durationSeconds: 7.3 };
    const motion = nodeOfType(graph, 'motion-generate');
    const withUpload: WorkflowCanvasGraph = {
      ...graph,
      nodes: [...graph.nodes, clip],
      edges: [
        ...graph.edges.filter((edge) => !(edge.target === motion.id && edge.sourceHandle === 'video')),
        createCanvasEdge(clip.id, 'video', motion.id, 'reference-video'),
      ],
    };
    expect(planWorkflowStepPrice(withUpload, motion)).toMatchObject({ input: { settings: { duration: 8 } } });

    clip.data = { ...clip.data, durationSeconds: null };
    expect(planWorkflowStepPrice(withUpload, motion)).toEqual({
      kind: 'unavailable',
      reason: 'A motion step is priced by its clip’s length, which is not known yet.',
    });
  });

  // The runner sends a clip to every model whose limits take one and charges
  // its measured length (workflow-runner.ts), so the canvas prices the step
  // from the length it knows, as an estimate, and not at all without one.
  it('prices a video step’s reference clips by their recorded lengths, as an estimate', () => {
    const graph = createStarterGraph();
    const video = nodeOfType(graph, 'video-generate');
    const clip = createWorkflowNode('video-input', { x: 0, y: 0 });
    clip.data = { ...clip.data, videoUrl: 'https://cdn.example/clip.mp4', durationSeconds: 7.3 };
    const withClip: WorkflowCanvasGraph = {
      ...graph,
      nodes: [...graph.nodes.map((node) => (node.id === video.id
        ? { ...node, data: { ...node.data, model: 'minimax-h3' } } as WorkflowCanvasNode
        : node)), clip],
      edges: [...graph.edges, createCanvasEdge(clip.id, 'video', video.id, 'reference-video')],
    };
    const step = withClip.nodes.find((node) => node.id === video.id)!;

    expect(planWorkflowStepPrice(withClip, step)).toMatchObject({
      kind: 'quote',
      approximate: true,
      input: {
        modelId: 'minimax-h3',
        inputCounts: { videos: 1, audios: 0 },
        inputMetadata: { referenceVideoDurationsSeconds: [7.3] },
      },
    });

    // Kling takes its clips as named elements, which the runner does not measure.
    const kling = { ...step, data: { ...step.data, model: 'kling-3.0-video' } } as WorkflowCanvasNode;
    const plan = planWorkflowStepPrice(withClip, kling);
    expect(plan).toMatchObject({ kind: 'quote', approximate: false, input: { inputCounts: { videos: 1 } } });
    expect((plan as { input: { inputMetadata?: unknown } }).input.inputMetadata).toBeUndefined();

    clip.data = { ...clip.data, durationSeconds: null };
    expect(planWorkflowStepPrice(withClip, step)).toEqual({
      kind: 'unavailable',
      reason: 'A step with a reference clip is priced by the clip’s length, which is not known yet.',
    });
  });

  it('says why audio and music steps carry no price', () => {
    const graph = createStarterGraph();
    expect(planWorkflowStepPrice(graph, createWorkflowNode('voiceover-generate', { x: 0, y: 0 }))).toEqual({
      kind: 'unavailable',
      reason: 'Audio steps are priced when they start.',
    });
    expect(planWorkflowStepPrice(graph, createWorkflowNode('sound-effects-generate', { x: 0, y: 0 }))).toMatchObject({ kind: 'unavailable' });
    expect(planWorkflowStepPrice(graph, createWorkflowNode('music-generate', { x: 0, y: 0 }))).toEqual({
      kind: 'unavailable',
      reason: 'Music steps cannot run yet.',
    });
  });
});

describe('formatWorkflowRunPrice', () => {
  it('words a price, an estimate, a wait and a missing price', () => {
    expect(formatWorkflowRunPrice(null)).toEqual({ label: null, note: null });
    expect(formatWorkflowRunPrice({ status: 'pending' })).toEqual({ label: 'Calculating…', note: null });
    expect(formatWorkflowRunPrice({ status: 'ready', costCredits: 1, approximate: false })).toEqual({ label: '1 credit', note: null });
    expect(formatWorkflowRunPrice({ status: 'ready', costCredits: 64, approximate: true })).toEqual({
      label: 'about 64 credits',
      note: 'A step with a reference clip is charged for the clip’s measured length.',
    });
    expect(formatWorkflowRunPrice({ status: 'unavailable', reason: 'Audio steps are priced when they start.' })).toEqual({
      label: 'Cost unavailable',
      note: 'Audio steps are priced when they start.',
    });
  });
});

describe('useWorkflowRunPrices', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/generation-models/quote') throw new Error(`Unexpected fetch ${String(input)}`);
      const body = JSON.parse(String(init?.body)) as { kind: string; modelId: string; settings?: { duration?: number } };
      if (body.modelId === 'retired-model') {
        return new Response(JSON.stringify({ code: 'MODEL_UNAVAILABLE', error: 'This model is no longer available.' }), { status: 409 });
      }
      return new Response(JSON.stringify({
        modelId: body.modelId,
        catalogRevision: 'rev-1',
        normalizedSettings: {},
        costCredits: priceFor(body),
      }), { status: 200 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prices one step for Run node and every step from it for Run branch, asking each quote once', async () => {
    const graph = createStarterGraph();
    const prompt = nodeOfType(graph, 'text-input');
    const image = nodeOfType(graph, 'image-generate');
    const videoSeconds = (nodeOfType(graph, 'video-generate').data as VideoGenerateNodeData).duration;
    expect(getExecutionOrder(graph, prompt.id, 'branch')).toHaveLength(4);

    const { result, rerender } = renderHook((props: { graph: WorkflowCanvasGraph; nodeIds: string[] }) => useWorkflowRunPrices({
      graph: props.graph,
      nodeIds: props.nodeIds,
      catalogRevision: 'rev-1',
      accessToken: 'token-1',
      enabled: true,
    }), { initialProps: { graph, nodeIds: [prompt.id, image.id] } });

    expect(result.current(prompt.id, 'branch')).toEqual({ status: 'pending' });
    await waitFor(() => expect(result.current(prompt.id, 'branch')).toEqual({
      status: 'ready',
      costCredits: 4 + 30 + 3 * videoSeconds,
      approximate: true,
    }));
    expect(result.current(image.id, 'node')).toEqual({ status: 'ready', costCredits: 4, approximate: false });
    expect(quotePosts()).toHaveLength(3);
    // The run is priced at the active revision, so the quote names none.
    expect(JSON.parse(String(quotePosts()[0][1]?.body))).not.toHaveProperty('catalogRevision');
    expect(new Headers(quotePosts()[0][1]?.headers).get('Authorization')).toBe('Bearer token-1');

    // Moving a node or reopening a menu asks nothing new; a changed setting asks again.
    rerender({ graph: { ...graph, viewport: { x: 10, y: 10, zoom: 1 } }, nodeIds: [image.id, prompt.id] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(quotePosts()).toHaveLength(3);

    const changed: WorkflowCanvasGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === image.id ? { ...node, data: { ...node.data, aspectRatio: '1:1' } } as WorkflowCanvasNode : node)),
    };
    rerender({ graph: changed, nodeIds: [prompt.id] });
    await waitFor(() => expect(quotePosts()).toHaveLength(4));
  });

  it('gives the server’s reason when a step cannot be quoted, and the step’s own when it is never quoted', async () => {
    const graph = createStarterGraph();
    const image = nodeOfType(graph, 'image-generate');
    const prompt = nodeOfType(graph, 'text-input');
    const voiceover = createWorkflowNode('voiceover-generate', { x: 0, y: 0 });
    const withRetiredModel: WorkflowCanvasGraph = {
      ...graph,
      nodes: [
        ...graph.nodes.map((node) => (node.id === image.id ? { ...node, data: { ...node.data, model: 'retired-model' } } as WorkflowCanvasNode : node)),
        voiceover,
      ],
      edges: [...graph.edges, createCanvasEdge(prompt.id, 'text', voiceover.id, 'prompt')],
    };

    const { result } = renderHook(() => useWorkflowRunPrices({
      graph: withRetiredModel,
      nodeIds: [image.id, voiceover.id],
      catalogRevision: 'rev-1',
      accessToken: null,
      enabled: true,
    }));

    await waitFor(() => expect(result.current(image.id, 'node')).toEqual({
      status: 'unavailable',
      reason: 'This model is no longer available.',
    }));
    expect(result.current(voiceover.id, 'node')).toEqual({
      status: 'unavailable',
      reason: 'Audio steps are priced when they start.',
    });
  });

  it('asks nothing while turned off', async () => {
    const graph = createStarterGraph();
    const prompt = nodeOfType(graph, 'text-input');

    const { result } = renderHook(() => useWorkflowRunPrices({
      graph,
      nodeIds: [prompt.id],
      catalogRevision: null,
      accessToken: 'token-1',
      enabled: false,
    }));

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(result.current(prompt.id, 'branch')).toBeNull();
    expect(quotePosts()).toHaveLength(0);
  });
});
