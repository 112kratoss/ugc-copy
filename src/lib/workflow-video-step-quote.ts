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
 * The reference clips and tracks a video step sends: every one the canvas connects, for a
 * model whose limits take them (the runner reads the same table). Kling 3.0's clips are its
 * named elements instead (`workflowVideoStepInputsFromGraph`).
 */
export function workflowVideoStepReferenceMedia(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode,
  data: VideoGenerateNodeData,
) {
  const support = data.model === 'kling-3.0-video' ? { videos: 0, audios: 0 } : getVideoReferenceSupport(data.model);
  const incoming = getIncomingEdges(graph, node.id);
  return {
    clipEdges: support.videos > 0 ? incoming.filter((edge) => edge.targetHandle === 'reference-video') : [],
    trackEdges: support.audios > 0 ? incoming.filter((edge) => edge.targetHandle === 'reference-audio') : [],
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
): WorkflowVideoStepInputs {
  const { clipEdges, trackEdges } = workflowVideoStepReferenceMedia(graph, node, data);
  return {
    referencePictures: getResolvedWorkflowImageReferences(graph, node.id).length,
    startFrame: countIncomingEdgesForTargetHandle(graph, node.id, 'start-frame') > 0,
    endFrame: countIncomingEdgesForTargetHandle(graph, node.id, 'end-frame') > 0,
    referenceClips: clipEdges.length,
    referenceTracks: trackEdges.length,
    videoElements: data.model === 'kling-3.0-video' ? getResolvedWorkflowVideoReferences(graph, node.id).length : 0,
  };
}
