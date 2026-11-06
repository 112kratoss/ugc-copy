import { describe, expect, it } from 'vitest';

import { planWorkflowStepPrice } from '@/app/create-workflow/useWorkflowRunPrices';
import { buildGenerationModelCatalog, quoteGenerationModel } from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type AudioInputNodeData,
  type ImageInputNodeData,
  type TextInputNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type WorkflowCanvasNode,
} from '@/lib/workflow-canvas';
import {
  workflowVideoStepInputsFromGraph,
  workflowVideoStepQuoteFacts,
  type WorkflowVideoStepInputs,
} from '@/lib/workflow-video-step-quote';

type StepHandle = 'start-frame' | 'end-frame' | 'reference-image' | 'image-reference' | 'element-image' | 'reference-video' | 'reference-audio';

/** A video step of the model, with an uploaded file on each input named. */
function graphWith(model: VideoGenerateNodeData['model'], handles: StepHandle[]) {
  const prompt = createWorkflowNode('text-input', { x: 0, y: -160 });
  const step = createWorkflowNode('video-generate', { x: 400, y: 0 });
  const sources = handles.map((handle, index) => {
    const kind = handle === 'reference-video' ? 'video-input' : handle === 'reference-audio' ? 'audio-input' : 'image-input';
    const node = createWorkflowNode(kind, { x: 0, y: index * 160 });
    if (kind === 'video-input') {
      return { ...node, data: { ...(node.data as VideoInputNodeData), videoUrl: `https://cdn.example.com/clip-${index}.mp4` } };
    }
    if (kind === 'audio-input') {
      return { ...node, data: { ...(node.data as AudioInputNodeData), audioUrl: `https://cdn.example.com/track-${index}.mp3` } };
    }
    return { ...node, data: { ...(node.data as ImageInputNodeData), imageUrl: `https://cdn.example.com/picture-${index}.png` } };
  }) as WorkflowCanvasNode[];
  const graph = normalizeWorkflowGraph({
    nodes: [
      { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'The camera pushes in slowly.' } },
      ...sources,
      { ...step, data: { ...(step.data as VideoGenerateNodeData), model } },
    ],
    edges: [
      createCanvasEdge(prompt.id, 'text', step.id, 'prompt'),
      ...handles.map((handle, index) => createCanvasEdge(
        sources[index]!.id,
        handle === 'reference-video' ? 'video' : handle === 'reference-audio' ? 'audio' : 'image',
        step.id,
        handle,
      )),
    ],
  });
  return { graph, node: graph.nodes.find((candidate) => candidate.id === step.id)! };
}

const NONE: WorkflowVideoStepInputs = {
  referencePictures: 0,
  startFrame: false,
  endFrame: false,
  referenceClips: 0,
  referenceTracks: 0,
  videoElements: 0,
};

describe('workflowVideoStepQuoteFacts', () => {
  it('quotes a step with no reference as a frames run, its frames counted as its pictures', () => {
    expect(workflowVideoStepQuoteFacts({ ...NONE, startFrame: true })).toEqual({
      referenceMode: 'frames',
      inputCounts: { images: 1, videos: 0, audios: 0 },
    });
    expect(workflowVideoStepQuoteFacts({ ...NONE, startFrame: true, endFrame: true })).toEqual({
      referenceMode: 'frames',
      inputCounts: { images: 2, videos: 0, audios: 0 },
    });
    expect(workflowVideoStepQuoteFacts(NONE)).toEqual({
      referenceMode: 'frames',
      inputCounts: { images: 0, videos: 0, audios: 0 },
    });
  });

  // The start sends a references run's pictures as references; a start frame beside them is
  // either refused or, on Wan 2.7, sent apart as `first_frame`, which its caps do not count.
  it('quotes a step with a reference picture, clip or track as a references run of its references alone', () => {
    expect(workflowVideoStepQuoteFacts({ ...NONE, referencePictures: 3 })).toEqual({
      referenceMode: 'elements',
      inputCounts: { images: 3, videos: 0, audios: 0 },
    });
    expect(workflowVideoStepQuoteFacts({ ...NONE, startFrame: true, referenceClips: 2 })).toEqual({
      referenceMode: 'elements',
      inputCounts: { images: 0, videos: 2, audios: 0 },
    });
    expect(workflowVideoStepQuoteFacts({ ...NONE, referenceTracks: 1, referencePictures: 1 })).toEqual({
      referenceMode: 'elements',
      inputCounts: { images: 1, videos: 0, audios: 1 },
    });
  });

  it('keeps a Kling 3.0 step with named video elements a frames run', () => {
    expect(workflowVideoStepQuoteFacts({ ...NONE, startFrame: true, endFrame: true, videoElements: 2 })).toEqual({
      referenceMode: 'frames',
      inputCounts: { images: 2, videos: 2, audios: 0 },
    });
  });
});

describe('workflowVideoStepInputsFromGraph', () => {
  function stepWith(model: VideoGenerateNodeData['model'], handles: StepHandle[]) {
    const { graph, node } = graphWith(model, handles);
    return workflowVideoStepInputsFromGraph(graph, node, node.data as VideoGenerateNodeData);
  }

  it('reads a step’s frames off its frame inputs, a non-Seedance reference-image edge among them', () => {
    expect(stepWith('vidu-q4', ['start-frame'])).toEqual({ ...NONE, startFrame: true });
    expect(stepWith('kling-4.0', ['reference-image', 'end-frame'])).toEqual({ ...NONE, startFrame: true, endFrame: true });
  });

  it('reads reference pictures as the runner resolves them, and clips only where the model takes them', () => {
    expect(stepWith('seedance-2', ['reference-image', 'reference-image', 'reference-video'])).toEqual({
      ...NONE,
      referencePictures: 2,
      referenceClips: 1,
    });
    expect(stepWith('vidu-q4', ['element-image'])).toEqual({ ...NONE, referencePictures: 1 });
    expect(stepWith('kling-3.0-video', ['start-frame', 'reference-video'])).toEqual({
      ...NONE,
      startFrame: true,
      videoElements: 1,
    });
  });

  // The runner sends every clip and track once a model's limits take either kind
  // (workflowVideoStepSendsReferenceMedia), so the prices count each one it sends.
  it('counts every clip and track the run sends, a track left on a model that takes clips alone among them', () => {
    expect(stepWith('gemini-omni-video', ['image-reference', 'reference-audio'])).toEqual({
      ...NONE,
      referencePictures: 1,
      referenceTracks: 1,
    });
    expect(stepWith('grok-imagine-video', ['start-frame', 'reference-video'])).toEqual({ ...NONE, startFrame: true });
  });
});

// The canvas's price for a step, on the code catalog: what the claims about accepted and refused
// steps rest on.
describe('the canvas price of a video step', () => {
  const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 });
  const operations = new Map(buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry]));

  function canvasCredits(model: VideoGenerateNodeData['model'], handles: StepHandle[]) {
    const { graph, node } = graphWith(model, handles);
    const plan = planWorkflowStepPrice(graph, node);
    if (plan.kind !== 'quote') throw new Error(`no quote: ${plan.kind}`);
    return quoteGenerationModel({ ...plan.input, catalogRevision: null }, { catalog, operations }).costCredits;
  }

  it('prices Gemini Omni Video with three to seven reference pictures as a references run, at the price of two', () => {
    const two = canvasCredits('gemini-omni-video', ['image-reference', 'image-reference']);
    expect(two).toBeGreaterThan(0);
    expect(canvasCredits('gemini-omni-video', Array<StepHandle>(3).fill('image-reference'))).toBe(two);
    expect(canvasCredits('gemini-omni-video', Array<StepHandle>(7).fill('image-reference'))).toBe(two);
    expect(() => canvasCredits('gemini-omni-video', Array<StepHandle>(8).fill('image-reference'))).toThrow();
  });

  it.each(['kling-3.0-video', 'kling-3.0-turbo', 'hailuo-2.3', 'pixverse-v6-max'] as const)(
    'refuses reference pictures on %s at the quote, as its start does',
    (model) => {
      expect(() => canvasCredits(model, ['image-reference'])).toThrow();
    },
  );

  it('refuses a track left on a model that takes clips alone, as its run is refused', () => {
    expect(canvasCredits('gemini-omni-video', ['image-reference'])).toBeGreaterThan(0);
    expect(() => canvasCredits('gemini-omni-video', ['image-reference', 'reference-audio'])).toThrow();
  });

  it('prices Vidu Q4 and Hailuo 2.3 steps that have a start frame alone', () => {
    expect(canvasCredits('vidu-q4', ['start-frame'])).toBeGreaterThan(0);
    expect(canvasCredits('hailuo-2.3', ['start-frame'])).toBeGreaterThan(0);
  });
});
