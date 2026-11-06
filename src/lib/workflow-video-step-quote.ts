import { getVideoReferenceSupport } from '@/lib/client-generation-models';
import {
  countIncomingEdgesForTargetHandle,
  getIncomingEdges,
  getResolvedWorkflowImageReferences,
  getResolvedWorkflowVideoReferences,
  type VideoGenerateNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
} from '@/lib/workflow-canvas';

/** What a workflow or template video step sends the video start (`startVideoGeneration`). */
export type WorkflowVideoStepInputs = {
  /** Reference pictures: the step's connected references and its own older elements. */
  referencePictures: number;
  startFrame: boolean;
  endFrame: boolean;
  /** Reference clips and tracks, sent to a model whose limits take them. */
  referenceClips: number;
  referenceTracks: number;
  /** Kling 3.0's clips, which go as named elements beside the frames of either kind of run. */
  videoElements: number;
};

export type WorkflowVideoStepQuoteFacts = {
  referenceMode: 'frames' | 'elements';
  inputCounts: { images: number; videos: number; audios: number };
};

/**
 * The reference mode and input totals a workflow or template video step is quoted with: the
 * run its start sends, counted as POST /api/generate-video counts one
 * (video-generation-start-service). A step with a reference picture, clip or track is a
 * references run, and its pictures are its references; a step with none is a frames run, and
 * its pictures are its frames. The quote is the step's credit hold. Counting no frames, it
 * refused every step of a model with no run from text alone (Vidu Q4, Hailuo 2.3) that had a
 * start frame and nothing else, and a template with one could not be priced.
 *
 * Wan 2.7 sends a start frame beside its references (`first_frame`), apart from them: the
 * release's caps count its references alone, so the frame is not counted there, as the
 * direct start does not count it. The totals name no slot, as the step's quote never has:
 * a quote that names its slots is held to the slots of the release it is quoted at
 * (normalizeGenerationModelInputFacts), and a template's steps are quoted at the release
 * the template was published against, however old.
 */
export function workflowVideoStepQuoteFacts(inputs: WorkflowVideoStepInputs): WorkflowVideoStepQuoteFacts {
  const sendsReferences = inputs.referencePictures + inputs.referenceClips + inputs.referenceTracks > 0;
  return {
    referenceMode: sendsReferences ? 'elements' : 'frames',
    inputCounts: {
      images: sendsReferences
        ? inputs.referencePictures
        : Number(inputs.startFrame) + Number(inputs.endFrame),
      videos: inputs.referenceClips + inputs.videoElements,
      audios: inputs.referenceTracks,
    },
  };
}

/**
 * Whether a video step sends its reference clips and tracks: every one connected, once the
 * model's limits take either kind (`getVideoReferenceSupport`). The runner decides with this
 * too, so the canvas price and a template's price count what the run sends: a track left
 * connected to a model that takes clips alone is sent, and refused by the quote, on all three.
 * Kling 3.0's clips go as named elements instead (`workflowVideoStepInputsFromGraph`).
 */
export function workflowVideoStepSendsReferenceMedia(model: VideoGenerateNodeData['model']): boolean {
  if (model === 'kling-3.0-video') return false;
  const support = getVideoReferenceSupport(model);
  return support.videos + support.audios > 0;
}

/** The reference clips and tracks a video step sends, by the edges that reach it. */
export function workflowVideoStepReferenceMedia(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode,
  data: VideoGenerateNodeData,
) {
  if (!workflowVideoStepSendsReferenceMedia(data.model)) return { clipEdges: [], trackEdges: [] };
  const incoming = getIncomingEdges(graph, node.id);
  return {
    clipEdges: incoming.filter((edge) => edge.targetHandle === 'reference-video'),
    trackEdges: incoming.filter((edge) => edge.targetHandle === 'reference-audio'),
  };
}

/**
 * A video step's inputs read off the canvas before it runs, by its connections rather than
 * by outputs the steps before it have not made yet: the canvas prices a step with these, and
 * a template is priced with them when it is published. A step runs only once every input it
 * is connected to has its file, so its run sends the same.
 */
export function workflowVideoStepInputsFromGraph(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode,
  data: VideoGenerateNodeData,
  media: ReturnType<typeof workflowVideoStepReferenceMedia> = workflowVideoStepReferenceMedia(graph, node, data),
): WorkflowVideoStepInputs {
  const { clipEdges, trackEdges } = media;
  return {
    referencePictures: getResolvedWorkflowImageReferences(graph, node.id).length,
    startFrame: countIncomingEdgesForTargetHandle(graph, node.id, 'start-frame') > 0,
    endFrame: countIncomingEdgesForTargetHandle(graph, node.id, 'end-frame') > 0,
    referenceClips: clipEdges.length,
    referenceTracks: trackEdges.length,
    videoElements: data.model === 'kling-3.0-video' ? getResolvedWorkflowVideoReferences(graph, node.id).length : 0,
  };
}
