import { describe, expect, it } from 'vitest';

import {
  createCanvasEdge,
  createWorkflowNode,
  normalizeWorkflowGraph,
  type ImageInputNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type WorkflowCanvasNode,
} from '@/lib/workflow-canvas';
import {
  workflowVideoStepInputsFromGraph,
  workflowVideoStepQuoteFacts,
  type WorkflowVideoStepInputs,
} from '@/lib/workflow-video-step-quote';

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
  /** A video step of the model, with an uploaded file on each input named. */
  function stepWith(model: VideoGenerateNodeData['model'], handles: Array<'start-frame' | 'end-frame' | 'reference-image' | 'element-image' | 'reference-video'>) {
    const step = createWorkflowNode('video-generate', { x: 400, y: 0 });
    const sources = handles.map((handle, index) => {
      const kind = handle === 'reference-video' ? 'video-input' : 'image-input';
      const node = createWorkflowNode(kind, { x: 0, y: index * 160 });
      return kind === 'video-input'
        ? { ...node, data: { ...(node.data as VideoInputNodeData), videoUrl: `https://cdn.example.com/clip-${index}.mp4` } }
        : { ...node, data: { ...(node.data as ImageInputNodeData), imageUrl: `https://cdn.example.com/picture-${index}.png` } };
    }) as WorkflowCanvasNode[];
    const graph = normalizeWorkflowGraph({
      nodes: [...sources, { ...step, data: { ...(step.data as VideoGenerateNodeData), model } }],
      edges: handles.map((handle, index) => createCanvasEdge(
        sources[index]!.id,
        handle === 'reference-video' ? 'video' : 'image',
        step.id,
        handle,
      )),
    });
    const node = graph.nodes.find((candidate) => candidate.id === step.id)!;
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
});
