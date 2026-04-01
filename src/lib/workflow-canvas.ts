import type { Edge, Node, Viewport } from '@xyflow/react';
import {
  buildElementHandle,
  findUnknownPromptHandles,
  isValidElementHandle,
  normalizeElementDisplayName,
  type ImageElementDescriptor,
} from '@/lib/image-elements';
import {
  IMAGE_MODELS,
  MOTION_MODELS,
  VIDEO_MODELS,
  clampVideoDuration,
  getDefaultVideoDuration,
  getVideoElementSupport,
  type ImageModelId,
  type MotionModelId,
  type SoundEffectModelId,
  type VideoModelId,
  type VoiceoverModelId,
} from '@/lib/models';

export const WORKFLOW_GRAPH_VERSION = 1;

export type WorkflowNodeKind =
  | 'text-input'
  | 'image-input'
  | 'video-input'
  | 'audio-input'
  | 'image-generate'
  | 'video-generate'
  | 'motion-generate'
  | 'voiceover-generate'
  | 'music-generate'
  | 'sound-effects-generate'
  | 'note'
  | 'group';

export type WorkflowHandleType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'prompt'
  | 'image-reference'
  | 'start-frame'
  | 'end-frame'
  | 'element-image'
  | 'reference-image'
  | 'reference-video'
  | 'reference-audio';

export type WorkflowRunStatus = 'idle' | 'queued' | 'processing' | 'succeeded' | 'failed' | 'blocked';

export interface WorkflowNodeRunState {
  status: WorkflowRunStatus;
  generationId: string | null;
  outputUrl: string | null;
  error: string | null;
  cost: number | null;
  updatedAt: string | null;
}

interface BaseWorkflowNodeData extends Record<string, unknown> {
  title: string;
  subtitle?: string;
  runState: WorkflowNodeRunState;
}

export interface TextInputNodeData extends BaseWorkflowNodeData {
  text: string;
}

export interface NoteNodeData extends BaseWorkflowNodeData {
  text: string;
}

export interface ImageInputNodeData extends BaseWorkflowNodeData {
  imageUrl: string | null;
  storagePath: string | null;
  referenceHandle: string | null;
}

export interface VideoInputNodeData extends BaseWorkflowNodeData {
  videoUrl: string | null;
  storagePath: string | null;
  durationSeconds: number | null;
}

export interface AudioInputNodeData extends BaseWorkflowNodeData {
  audioUrl: string | null;
  storagePath: string | null;
}

export interface WorkflowReferenceElement extends ImageElementDescriptor {
  url: string | null;
}

export interface WorkflowReferenceBinding {
  edgeId: string;
  handle: string | null;
}

export type WorkflowElementBinding = WorkflowReferenceBinding;

export interface WorkflowMultiPrompt {
  id: string;
  prompt: string;
  duration: number;
}

export interface ImageGenerateNodeData extends BaseWorkflowNodeData {
  model: ImageModelId;
  aspectRatio: string;
  resolution: '1K' | '2K' | '4K';
  outputFormat: 'jpg' | 'png';
  googleSearch: boolean;
  referenceHandle: string | null;
  referenceBindings: WorkflowReferenceBinding[];
  elements: WorkflowReferenceElement[];
}

export interface VideoGenerateNodeData extends BaseWorkflowNodeData {
  model: VideoModelId;
  aspectRatio: string;
  duration: number;
  mode: string;
  sound: boolean;
  resolution: string;
  fixedLens: boolean;
  referenceMode: 'frames' | 'elements';
  referenceBindings: WorkflowReferenceBinding[];
  elements: WorkflowReferenceElement[];
  isMultiShot: boolean;
  multiPrompts: WorkflowMultiPrompt[];
}

export interface MotionGenerateNodeData extends BaseWorkflowNodeData {
  model: MotionModelId;
  mode: '720p' | '1080p';
  characterOrientation: 'video' | 'image';
}

export interface DialogueTurn {
  id: string;
  voice: string;
  text: string;
}

export interface VoiceoverGenerateNodeData extends BaseWorkflowNodeData {
  model: VoiceoverModelId;
  voice: string;
  languageCode: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  timestamps: boolean;
  dialogueTurns: DialogueTurn[];
}

export interface MusicGenerateNodeData extends BaseWorkflowNodeData {
  model: 'music-v1';
  duration: number;
  mood: string;
}

export interface SoundEffectsGenerateNodeData extends BaseWorkflowNodeData {
  model: SoundEffectModelId;
  duration: number;
  loop: boolean;
  promptInfluence: number;
  outputFormat: 'mp3' | 'wav';
}

export interface GroupNodeData extends BaseWorkflowNodeData {
  color: string;
}

export type WorkflowNodeData =
  | TextInputNodeData
  | NoteNodeData
  | ImageInputNodeData
  | VideoInputNodeData
  | AudioInputNodeData
  | ImageGenerateNodeData
  | VideoGenerateNodeData
  | MotionGenerateNodeData
  | VoiceoverGenerateNodeData
  | MusicGenerateNodeData
  | SoundEffectsGenerateNodeData
  | GroupNodeData;

export type WorkflowCanvasNode = Node<WorkflowNodeData, WorkflowNodeKind>;
export type WorkflowCanvasEdge = Edge;

export interface WorkflowCanvasGraph {
  version: number;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  viewport: Viewport;
}

export interface WorkflowCanvasListItem {
  id: string;
  title: string;
  updated_at: string;
  revision: number;
  status: WorkflowCanvasStatus;
  published_at: string | null;
}

export type WorkflowGraphSerializationMode = 'storage' | 'client-save';

export interface SerializedWorkflowCanvasNode {
  id: string;
  type: WorkflowNodeKind;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  draggable: boolean;
}

export interface SerializedWorkflowCanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface SerializedWorkflowCanvasGraph {
  version: number;
  nodes: SerializedWorkflowCanvasNode[];
  edges: SerializedWorkflowCanvasEdge[];
  viewport: Viewport;
}

export interface SerializeWorkflowGraphOptions {
  mode?: WorkflowGraphSerializationMode;
}

export interface WorkflowCanvasRecord {
  id: string;
  title: string;
  graph: WorkflowCanvasGraph;
  created_at: string;
  updated_at: string;
  revision: number;
  status: WorkflowCanvasStatus;
  published_at: string | null;
}

export type WorkflowCanvasStatus = 'draft' | 'published';
export type WorkflowCanvasHistoryKind = 'draft' | 'published' | 'restored';

export interface WorkflowCanvasHistoryEntry {
  id: string;
  canvas_id: string;
  title: string;
  graph: WorkflowCanvasGraph;
  revision: number;
  kind: WorkflowCanvasHistoryKind;
  created_at: string;
}

interface WorkflowNodeHandleSchema {
  inputs: WorkflowHandleType[];
  outputs: WorkflowHandleType[];
}

export interface WorkflowCanvasRunStepRecord {
  id: string;
  node_id: string;
  status: WorkflowRunStatus | 'queued';
  generation_id: string | null;
  input_snapshot: Record<string, unknown> | null;
  output_snapshot: Record<string, unknown> | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkflowCanvasRunRecord {
  id: string;
  canvas_id: string;
  start_node_id: string;
  mode: 'node' | 'branch';
  status: 'processing' | 'succeeded' | 'failed';
  created_at: string;
  finished_at: string | null;
  steps?: WorkflowCanvasRunStepRecord[];
}

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 0.85 };

export const WORKFLOW_NODE_HANDLE_SCHEMAS: Record<WorkflowNodeKind, WorkflowNodeHandleSchema> = {
  'text-input': {
    inputs: ['prompt'],
    outputs: ['text'],
  },
  note: {
    inputs: [],
    outputs: [],
  },
  group: {
    inputs: [],
    outputs: [],
  },
  'image-input': {
    inputs: [],
    outputs: ['image'],
  },
  'video-input': {
    inputs: [],
    outputs: ['video'],
  },
  'audio-input': {
    inputs: [],
    outputs: ['audio'],
  },
  'image-generate': {
    inputs: ['prompt', 'image-reference'],
    outputs: ['image'],
  },
  'video-generate': {
    inputs: ['prompt', 'start-frame', 'end-frame'],
    outputs: ['video'],
  },
  'motion-generate': {
    inputs: ['reference-image', 'reference-video', 'prompt'],
    outputs: ['video'],
  },
  'voiceover-generate': {
    inputs: ['prompt'],
    outputs: ['audio'],
  },
  'music-generate': {
    inputs: ['prompt'],
    outputs: ['audio'],
  },
  'sound-effects-generate': {
    inputs: ['prompt'],
    outputs: ['audio'],
  },
};

export const EMPTY_RUN_STATE: WorkflowNodeRunState = {
  status: 'idle',
  generationId: null,
  outputUrl: null,
  error: null,
  cost: null,
  updatedAt: null,
};

const DEFAULT_IMAGE_GENERATE_MODEL: ImageModelId = 'nano-banana-2';
const DEFAULT_IMAGE_ASPECT_RATIO = '9:16';
const DEFAULT_IMAGE_RESOLUTION: ImageGenerateNodeData['resolution'] = '1K';
const DEFAULT_IMAGE_OUTPUT_FORMAT: ImageGenerateNodeData['outputFormat'] = 'jpg';
const DEFAULT_VIDEO_GENERATE_MODEL: VideoModelId = 'kling-3.0-video';
const DEFAULT_VIDEO_ASPECT_RATIO = '9:16';
const DEFAULT_VIDEO_MODE = 'std';

export function createNodeRunState(overrides?: Partial<WorkflowNodeRunState>): WorkflowNodeRunState {
  return { ...EMPTY_RUN_STATE, ...overrides };
}

export function createNodeData(type: WorkflowNodeKind): WorkflowNodeData {
  switch (type) {
    case 'text-input':
      return { title: 'Prompt', subtitle: 'Text input', text: 'Describe the scene, offer, or instruction here.', runState: createNodeRunState() };
    case 'image-input':
      return {
        title: 'Image input',
        subtitle: 'Upload or connect image',
        imageUrl: null,
        storagePath: null,
        referenceHandle: null,
        runState: createNodeRunState(),
      };
    case 'video-input':
      return { title: 'Video input', subtitle: 'Upload or connect video', videoUrl: null, storagePath: null, durationSeconds: null, runState: createNodeRunState() };
    case 'audio-input':
      return { title: 'Audio input', subtitle: 'Upload or connect audio', audioUrl: null, storagePath: null, runState: createNodeRunState() };
    case 'image-generate':
      return {
        title: 'Image generator',
        subtitle: 'Nano Banana',
        model: DEFAULT_IMAGE_GENERATE_MODEL,
        aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
        resolution: DEFAULT_IMAGE_RESOLUTION,
        outputFormat: DEFAULT_IMAGE_OUTPUT_FORMAT,
        googleSearch: false,
        referenceHandle: null,
        referenceBindings: [],
        elements: [],
        runState: createNodeRunState(),
      };
    case 'video-generate':
      return {
        title: 'Video generator',
        subtitle: 'Kling / Seedance / Veo',
        model: DEFAULT_VIDEO_GENERATE_MODEL,
        aspectRatio: DEFAULT_VIDEO_ASPECT_RATIO,
        duration: getDefaultVideoDuration(DEFAULT_VIDEO_GENERATE_MODEL),
        mode: DEFAULT_VIDEO_MODE,
        sound: false,
        resolution: '',
        fixedLens: false,
        referenceMode: 'frames',
        referenceBindings: [],
        elements: [],
        isMultiShot: false,
        multiPrompts: [
          { id: 'shot-1', prompt: '', duration: 5 },
        ],
        runState: createNodeRunState(),
      };
    case 'motion-generate':
      return {
        title: 'Motion control',
        subtitle: 'Character motion transfer',
        model: 'kling-3.0',
        mode: '720p',
        characterOrientation: 'video',
        runState: createNodeRunState(),
      };
    case 'voiceover-generate':
      return {
        title: 'Voiceover',
        subtitle: 'ElevenLabs speech',
        model: 'text-to-speech-turbo-2-5',
        voice: 'Rachel',
        languageCode: 'en',
        stability: 0.4,
        similarityBoost: 0.8,
        style: 0,
        speed: 1,
        timestamps: false,
        dialogueTurns: [
          { id: 'turn-1', voice: 'Rachel', text: 'Hey, I finally found a workflow that makes voiceover drafts feel instant.' },
          { id: 'turn-2', voice: 'Adam', text: 'Perfect, let us turn that into a clean back-and-forth demo.' },
        ],
        runState: createNodeRunState(),
      };
    case 'music-generate':
      return {
        title: 'Music',
        subtitle: 'Background score',
        model: 'music-v1',
        duration: 30,
        mood: 'uplifting electronic',
        runState: createNodeRunState(),
      };
    case 'sound-effects-generate':
      return {
        title: 'Sound effects',
        subtitle: 'ElevenLabs SFX',
        model: 'sound-effect-v2',
        duration: 5,
        loop: false,
        promptInfluence: 0.3,
        outputFormat: 'mp3',
        runState: createNodeRunState(),
      };
    case 'note':
      return { title: 'Note', subtitle: 'Canvas note', text: 'Use this space for instructions, references, or team context.', runState: createNodeRunState() };
    case 'group':
      return { title: 'Group', subtitle: 'Visual grouping', color: 'amber', runState: createNodeRunState() };
  }
}

export function createWorkflowNode(type: WorkflowNodeKind, position: { x: number; y: number }): WorkflowCanvasNode {
  return {
    id: `${type}-${crypto.randomUUID()}`,
    type,
    position,
    data: createNodeData(type),
    draggable: true,
  };
}

export function createStarterGraph(): WorkflowCanvasGraph {
  const prompt = createWorkflowNode('text-input', { x: 120, y: 60 });
  const imageInput = createWorkflowNode('image-input', { x: 120, y: 280 });
  const imageGen = createWorkflowNode('image-generate', { x: 460, y: 40 });
  const videoGen = createWorkflowNode('video-generate', { x: 460, y: 240 });
  const motionGen = createWorkflowNode('motion-generate', { x: 840, y: 240 });
  const note = createWorkflowNode('note', { x: 120, y: 500 });

  return normalizeWorkflowGraph({
    version: WORKFLOW_GRAPH_VERSION,
    viewport: DEFAULT_VIEWPORT,
    nodes: [
      { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'UGC creator in a warmly lit room introducing the product and landing a strong CTA.' } },
      imageInput,
      videoGen,
      imageGen,
      motionGen,
      { ...note, data: { ...(note.data as NoteNodeData), text: 'Starter template: prompt can branch into image and video generation. Image output can feed the video generator for first-frame setups.' } },
    ],
    edges: [
      createCanvasEdge(prompt.id, 'text', imageGen.id, 'prompt'),
      createCanvasEdge(prompt.id, 'text', videoGen.id, 'prompt'),
      createCanvasEdge(imageInput.id, 'image', videoGen.id, 'start-frame'),
      createCanvasEdge(videoGen.id, 'video', motionGen.id, 'reference-video'),
      createCanvasEdge(imageInput.id, 'image', motionGen.id, 'reference-image'),
    ],
  });
}

export function createCanvasEdge(source: string, sourceHandle: WorkflowHandleType, target: string, targetHandle: WorkflowHandleType): WorkflowCanvasEdge {
  return {
    id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  };
}

function serializeWorkflowNodeData(
  type: WorkflowNodeKind,
  data: Partial<WorkflowNodeData> | undefined,
  mode: WorkflowGraphSerializationMode
): Record<string, unknown> {
  const normalized = normalizeNodeData(type, data) as Record<string, unknown>;

  if (mode === 'client-save') {
    const editableData = { ...normalized };
    delete editableData.runState;
    return editableData;
  }

  return {
    ...normalized,
    runState: createNodeRunState((normalized.runState as Partial<WorkflowNodeRunState> | undefined) ?? undefined),
  };
}

export function serializeWorkflowGraph(
  value: Partial<WorkflowCanvasGraph> | null | undefined,
  options?: SerializeWorkflowGraphOptions
): SerializedWorkflowCanvasGraph {
  const mode = options?.mode ?? 'storage';
  const graph = normalizeWorkflowGraph(value);

  return {
    version: graph.version,
    viewport: normalizeViewport(graph.viewport),
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: {
        x: node.position.x,
        y: node.position.y,
      },
      data: serializeWorkflowNodeData(node.type, node.data, mode),
      draggable: node.draggable ?? true,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  };
}

export function createWorkflowGraphHash(
  graph: Partial<WorkflowCanvasGraph> | null | undefined,
  options?: SerializeWorkflowGraphOptions
): string {
  const serialized = JSON.stringify(serializeWorkflowGraph(graph, options));
  let hash = 5381;

  for (let index = 0; index < serialized.length; index += 1) {
    hash = ((hash << 5) + hash) + serialized.charCodeAt(index);
  }

  return (hash >>> 0).toString(16);
}

export function normalizeWorkflowGraph(value: Partial<WorkflowCanvasGraph> | null | undefined): WorkflowCanvasGraph {
  const rawNodes = Array.isArray(value?.nodes) ? value.nodes : [];
  const rawEdges = Array.isArray(value?.edges) ? value.edges : [];

  const nodes = rawNodes.map((node) => normalizeNode(node)).filter(Boolean) as WorkflowCanvasNode[];
  return syncWorkflowGraphElementBindings({
    version: typeof value?.version === 'number' ? value.version : WORKFLOW_GRAPH_VERSION,
    viewport: normalizeViewport(value?.viewport),
    nodes,
    edges: rawEdges.filter((edge): edge is WorkflowCanvasEdge => Boolean(edge?.id && edge.source && edge.target)),
  });
}

export function mergeWorkflowCanvasGraph(
  existingValue: Partial<WorkflowCanvasGraph> | null | undefined,
  incomingValue: Partial<WorkflowCanvasGraph> | null | undefined
): SerializedWorkflowCanvasGraph {
  const existingGraph = normalizeWorkflowGraph(existingValue);
  const incomingGraph = normalizeWorkflowGraph(incomingValue);
  const existingNodeMap = new Map(existingGraph.nodes.map((node) => [node.id, node]));

  return serializeWorkflowGraph({
    ...incomingGraph,
    nodes: incomingGraph.nodes.map((node) => {
      const existingNode = existingNodeMap.get(node.id);
      const nextRunState = existingNode && existingNode.type === node.type
        ? existingNode.data.runState
        : createNodeRunState();

      return {
        ...node,
        data: normalizeNodeData(node.type, {
          ...node.data,
          runState: nextRunState,
        }),
      };
    }),
  });
}

function normalizeViewport(value: Partial<Viewport> | undefined): Viewport {
  return {
    x: typeof value?.x === 'number' ? value.x : DEFAULT_VIEWPORT.x,
    y: typeof value?.y === 'number' ? value.y : DEFAULT_VIEWPORT.y,
    zoom: typeof value?.zoom === 'number' ? value.zoom : DEFAULT_VIEWPORT.zoom,
  };
}

function normalizeNode(node: Partial<WorkflowCanvasNode> | null | undefined): WorkflowCanvasNode | null {
  if (!node?.id || !node.type || !isWorkflowNodeKind(node.type)) {
    return null;
  }

  const data = normalizeNodeData(node.type, node.data as Partial<WorkflowNodeData> | undefined);
  return {
    id: node.id,
    type: node.type,
    position: {
      x: typeof node.position?.x === 'number' ? node.position.x : 0,
      y: typeof node.position?.y === 'number' ? node.position.y : 0,
    },
    data,
    width: node.width,
    height: node.height,
    selected: node.selected,
    draggable: node.draggable ?? true,
  };
}

export function normalizeNodeData(type: WorkflowNodeKind, data?: Partial<WorkflowNodeData>): WorkflowNodeData {
  const base = createNodeData(type);
  const metadata = data as Partial<BaseWorkflowNodeData> | undefined;
  const runState = createNodeRunState((data as Partial<BaseWorkflowNodeData> | undefined)?.runState);
  const title = typeof metadata?.title === 'string' && metadata.title.trim() ? metadata.title : base.title;
  const subtitle = typeof metadata?.subtitle === 'string' && metadata.subtitle.trim()
    ? metadata.subtitle
    : base.subtitle;

  switch (type) {
    case 'text-input':
      return { ...(base as TextInputNodeData), title, subtitle, text: typeof (data as TextInputNodeData | undefined)?.text === 'string' ? (data as TextInputNodeData).text : (base as TextInputNodeData).text, runState };
    case 'note':
      return { ...(base as NoteNodeData), title, subtitle, text: typeof (data as NoteNodeData | undefined)?.text === 'string' ? (data as NoteNodeData).text : (base as NoteNodeData).text, runState };
    case 'image-input':
      return {
        ...(base as ImageInputNodeData),
        title,
        subtitle,
        imageUrl: typeof (data as ImageInputNodeData | undefined)?.imageUrl === 'string' ? (data as ImageInputNodeData).imageUrl : null,
        storagePath: typeof (data as ImageInputNodeData | undefined)?.storagePath === 'string' ? (data as ImageInputNodeData).storagePath : null,
        referenceHandle: normalizeWorkflowReferenceHandle((data as ImageInputNodeData | undefined)?.referenceHandle),
        runState,
      };
    case 'video-input':
      return {
        ...(base as VideoInputNodeData),
        title,
        subtitle,
        videoUrl: typeof (data as VideoInputNodeData | undefined)?.videoUrl === 'string' ? (data as VideoInputNodeData).videoUrl : null,
        storagePath: typeof (data as VideoInputNodeData | undefined)?.storagePath === 'string' ? (data as VideoInputNodeData).storagePath : null,
        durationSeconds: typeof (data as VideoInputNodeData | undefined)?.durationSeconds === 'number'
          ? (data as VideoInputNodeData).durationSeconds
          : null,
        runState,
      };
    case 'audio-input':
      return { ...(base as AudioInputNodeData), title, subtitle, audioUrl: typeof (data as AudioInputNodeData | undefined)?.audioUrl === 'string' ? (data as AudioInputNodeData).audioUrl : null, storagePath: typeof (data as AudioInputNodeData | undefined)?.storagePath === 'string' ? (data as AudioInputNodeData).storagePath : null, runState };
    case 'image-generate':
      return normalizeImageGenerateNodeData({
        base: base as ImageGenerateNodeData,
        data: data as ImageGenerateNodeData | undefined,
        title,
        subtitle,
        runState,
      });
    case 'video-generate':
      return normalizeVideoGenerateNodeData({
        base: base as VideoGenerateNodeData,
        data: data as VideoGenerateNodeData | undefined,
        title,
        subtitle,
        runState,
      });
    case 'motion-generate':
      return {
        ...(base as MotionGenerateNodeData),
        title,
        subtitle,
        model: isMotionModel((data as MotionGenerateNodeData | undefined)?.model)
          ? (data as MotionGenerateNodeData).model
          : (base as MotionGenerateNodeData).model,
        mode: (data as MotionGenerateNodeData | undefined)?.mode === '1080p' ? '1080p' : '720p',
        characterOrientation: (data as MotionGenerateNodeData | undefined)?.characterOrientation === 'image' ? 'image' : 'video',
        runState,
      };
    case 'voiceover-generate':
      return {
        ...(base as VoiceoverGenerateNodeData),
        title,
        subtitle,
        model: normalizeVoiceoverModel((data as VoiceoverGenerateNodeData | undefined)?.model),
        voice: typeof (data as VoiceoverGenerateNodeData | undefined)?.voice === 'string' ? (data as VoiceoverGenerateNodeData).voice : (base as VoiceoverGenerateNodeData).voice,
        languageCode: getLegacyLanguageCode(data as VoiceoverGenerateNodeData | undefined) ?? (base as VoiceoverGenerateNodeData).languageCode,
        stability: normalizeNumericValue((data as VoiceoverGenerateNodeData | undefined)?.stability, (base as VoiceoverGenerateNodeData).stability),
        similarityBoost: normalizeNumericValue((data as VoiceoverGenerateNodeData | undefined)?.similarityBoost, (base as VoiceoverGenerateNodeData).similarityBoost),
        style: normalizeNumericValue((data as VoiceoverGenerateNodeData | undefined)?.style, (base as VoiceoverGenerateNodeData).style),
        speed: normalizeNumericValue((data as VoiceoverGenerateNodeData | undefined)?.speed, (base as VoiceoverGenerateNodeData).speed),
        timestamps: typeof (data as VoiceoverGenerateNodeData | undefined)?.timestamps === 'boolean' ? (data as VoiceoverGenerateNodeData).timestamps : (base as VoiceoverGenerateNodeData).timestamps,
        dialogueTurns: normalizeDialogueTurns((data as VoiceoverGenerateNodeData | undefined)?.dialogueTurns, (base as VoiceoverGenerateNodeData).dialogueTurns),
        runState,
      };
    case 'music-generate':
      return {
        ...(base as MusicGenerateNodeData),
        title,
        subtitle,
        model: 'music-v1',
        duration: typeof (data as MusicGenerateNodeData | undefined)?.duration === 'number' ? (data as MusicGenerateNodeData).duration : (base as MusicGenerateNodeData).duration,
        mood: typeof (data as MusicGenerateNodeData | undefined)?.mood === 'string' ? (data as MusicGenerateNodeData).mood : (base as MusicGenerateNodeData).mood,
        runState,
      };
    case 'sound-effects-generate':
      return {
        ...(base as SoundEffectsGenerateNodeData),
        title,
        subtitle,
        model: normalizeSoundEffectModel((data as SoundEffectsGenerateNodeData | undefined)?.model),
        duration: typeof (data as SoundEffectsGenerateNodeData | undefined)?.duration === 'number' ? (data as SoundEffectsGenerateNodeData).duration : (base as SoundEffectsGenerateNodeData).duration,
        loop: Boolean((data as SoundEffectsGenerateNodeData | undefined)?.loop),
        promptInfluence: normalizeNumericValue((data as SoundEffectsGenerateNodeData | undefined)?.promptInfluence, (base as SoundEffectsGenerateNodeData).promptInfluence),
        outputFormat: (data as SoundEffectsGenerateNodeData | undefined)?.outputFormat === 'wav' ? 'wav' : 'mp3',
        runState,
      };
    case 'group':
      return { ...(base as GroupNodeData), title, subtitle, color: typeof (data as GroupNodeData | undefined)?.color === 'string' ? (data as GroupNodeData).color : (base as GroupNodeData).color, runState };
  }
}

function normalizeImageGenerateNodeData(params: {
  base: ImageGenerateNodeData;
  data: ImageGenerateNodeData | undefined;
  title: string;
  subtitle?: string;
  runState: WorkflowNodeRunState;
}): ImageGenerateNodeData {
  const { base, data, title, subtitle, runState } = params;
  const model = isImageModel(data?.model) ? data.model : DEFAULT_IMAGE_GENERATE_MODEL;
  const modelConfig = IMAGE_MODELS[model];
  const aspectRatio = normalizeStringOption(
    data?.aspectRatio,
    modelConfig.aspectRatios,
    getPreferredOption(modelConfig.aspectRatios, base.aspectRatio, DEFAULT_IMAGE_ASPECT_RATIO)
  );
  const resolution = normalizeStringOption(
    data?.resolution,
    modelConfig.resolutions,
    getPreferredOption(modelConfig.resolutions, base.resolution, DEFAULT_IMAGE_RESOLUTION)
  ) as ImageGenerateNodeData['resolution'];
  const outputFormat = normalizeStringOption(
    data?.outputFormat,
    modelConfig.outputFormats,
    getPreferredOption(modelConfig.outputFormats, base.outputFormat, DEFAULT_IMAGE_OUTPUT_FORMAT)
  ) as ImageGenerateNodeData['outputFormat'];

  return {
    ...base,
    title,
    subtitle,
    model,
    aspectRatio,
    resolution,
    outputFormat,
    googleSearch: modelConfig.supportsGoogleSearch ? Boolean(data?.googleSearch) : false,
    referenceHandle: normalizeWorkflowReferenceHandle(data?.referenceHandle),
    referenceBindings: normalizeWorkflowReferenceBindings(
      data?.referenceBindings ?? (data as Partial<ImageGenerateNodeData> & { elementBindings?: unknown } | undefined)?.elementBindings
    ),
    elements: normalizeWorkflowReferenceElements(data?.elements),
    runState,
  };
}

function normalizeVideoGenerateNodeData(params: {
  base: VideoGenerateNodeData;
  data: VideoGenerateNodeData | undefined;
  title: string;
  subtitle?: string;
  runState: WorkflowNodeRunState;
}): VideoGenerateNodeData {
  const { base, data, title, subtitle, runState } = params;
  const model = isVideoModel(data?.model) ? data.model : DEFAULT_VIDEO_GENERATE_MODEL;
  const modelConfig = VIDEO_MODELS[model];

  return {
    ...base,
    title,
    subtitle,
    model,
    aspectRatio: normalizeStringOption(
      data?.aspectRatio,
      modelConfig.aspectRatios,
      getPreferredOption(modelConfig.aspectRatios, base.aspectRatio, DEFAULT_VIDEO_ASPECT_RATIO)
    ),
    duration: normalizeVideoDuration(model, data?.duration, base.duration),
    mode: modelConfig.modeOptions.length > 0
      ? normalizeStringOption(
          data?.mode,
          modelConfig.modeOptions.map((option) => option.value),
          getPreferredOption(
            modelConfig.modeOptions.map((option) => option.value),
            base.mode,
            DEFAULT_VIDEO_MODE
          )
        )
      : '',
    sound: modelConfig.supportsSound ? Boolean(data?.sound) : false,
    resolution: modelConfig.resolutions.length > 0
      ? normalizeStringOption(
          data?.resolution,
          modelConfig.resolutions,
          getPreferredOption(modelConfig.resolutions, base.resolution)
        )
      : '',
    fixedLens: modelConfig.supportsFixedLens ? Boolean(data?.fixedLens) : false,
    referenceMode: data?.referenceMode === 'elements' ? 'elements' : 'frames',
    referenceBindings: normalizeWorkflowReferenceBindings(
      data?.referenceBindings ?? (data as Partial<VideoGenerateNodeData> & { elementBindings?: unknown } | undefined)?.elementBindings
    ),
    elements: normalizeWorkflowReferenceElements(data?.elements),
    isMultiShot: Boolean(data?.isMultiShot),
    multiPrompts: normalizeWorkflowMultiPrompts(data?.multiPrompts),
    runState,
  };
}

function normalizeWorkflowReferenceHandle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!normalized) {
    return null;
  }

  const handle = `@${normalized}`;
  return isValidElementHandle(handle) ? handle : null;
}

function normalizeWorkflowReferenceBindings(value: unknown): WorkflowReferenceBinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenEdgeIds = new Set<string>();

  return value
    .map((binding, index) => {
      if (!binding || typeof binding !== 'object') {
        return null;
      }

      const typedBinding = binding as Partial<WorkflowElementBinding>;
      if (typeof typedBinding.edgeId !== 'string' || !typedBinding.edgeId.trim() || seenEdgeIds.has(typedBinding.edgeId)) {
        return null;
      }
      seenEdgeIds.add(typedBinding.edgeId);

      return {
        edgeId: typedBinding.edgeId,
        handle: normalizeWorkflowReferenceHandle(typedBinding.handle),
      } satisfies WorkflowReferenceBinding;
    })
    .filter((binding): binding is WorkflowReferenceBinding => Boolean(binding));
}

function normalizeWorkflowReferenceElements(value: unknown): WorkflowReferenceElement[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const usedHandles = new Set<string>();

  return value
    .map((element, index) => {
      if (!element || typeof element !== 'object') {
        return null;
      }

      const typedElement = element as Partial<WorkflowReferenceElement>;
      if (typeof typedElement.id !== 'string' || !typedElement.id.trim()) {
        return null;
      }

      const displayName = normalizeElementDisplayName(typedElement.displayName, index + 1);
      let handle = typeof typedElement.handle === 'string' ? typedElement.handle : '';

      if (!isValidElementHandle(handle) || usedHandles.has(handle)) {
        handle = buildElementHandle(displayName, usedHandles, index + 1);
      } else {
        usedHandles.add(handle);
      }

      return {
        id: typedElement.id,
        displayName,
        handle,
        storagePath: typeof typedElement.storagePath === 'string' ? typedElement.storagePath : null,
        sourceGenerationId:
          typeof typedElement.sourceGenerationId === 'string'
            ? typedElement.sourceGenerationId
            : null,
        url: typeof typedElement.url === 'string' ? typedElement.url : null,
      } satisfies WorkflowReferenceElement;
    })
    .filter((element): element is WorkflowReferenceElement => Boolean(element));
}

function normalizeWorkflowMultiPrompts(value: unknown): WorkflowMultiPrompt[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ id: 'shot-1', prompt: '', duration: 5 }];
  }

  const prompts = value
    .map((shot, index) => {
      if (!shot || typeof shot !== 'object') {
        return null;
      }

      const typedShot = shot as Partial<WorkflowMultiPrompt>;
      return {
        id:
          typeof typedShot.id === 'string' && typedShot.id.trim()
            ? typedShot.id
            : `shot-${index + 1}`,
        prompt: typeof typedShot.prompt === 'string' ? typedShot.prompt : '',
        duration:
          typeof typedShot.duration === 'number' && Number.isFinite(typedShot.duration)
            ? Math.max(1, Math.min(12, Math.round(typedShot.duration)))
            : 5,
      } satisfies WorkflowMultiPrompt;
    })
    .filter((shot): shot is WorkflowMultiPrompt => Boolean(shot));

  return prompts.length > 0 ? prompts : [{ id: 'shot-1', prompt: '', duration: 5 }];
}

function isVideoModel(value: unknown): value is VideoGenerateNodeData['model'] {
  return typeof value === 'string' && value in VIDEO_MODELS;
}

function isImageModel(value: unknown): value is ImageGenerateNodeData['model'] {
  return typeof value === 'string' && value in IMAGE_MODELS;
}

function isMotionModel(value: unknown): value is MotionGenerateNodeData['model'] {
  return typeof value === 'string' && value in MOTION_MODELS;
}

function getPreferredOption(options: readonly string[], ...preferredValues: Array<string | undefined>): string {
  for (const preferredValue of preferredValues) {
    if (preferredValue && options.includes(preferredValue)) {
      return preferredValue;
    }
  }

  return options[0] || '';
}

function normalizeStringOption(
  value: unknown,
  options: readonly string[],
  fallback: string
): string {
  return typeof value === 'string' && options.includes(value) ? value : fallback;
}

function normalizeVideoDuration(
  model: VideoModelId,
  duration: unknown,
  fallbackDuration: number
): number {
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    return clampVideoDuration(model, duration);
  }

  if (Number.isFinite(fallbackDuration)) {
    return clampVideoDuration(model, fallbackDuration);
  }

  return getDefaultVideoDuration(model);
}

function normalizeVoiceoverModel(value: unknown): VoiceoverGenerateNodeData['model'] {
  if (value === 'text-to-speech-multilingual-v2' || value === 'text-to-dialogue-v3') {
    return value;
  }

  return 'text-to-speech-turbo-2-5';
}

function normalizeSoundEffectModel(value: unknown): SoundEffectsGenerateNodeData['model'] {
  return value === 'sound-effect-v2' || value === 'sfx-v1' ? 'sound-effect-v2' : 'sound-effect-v2';
}

function normalizeDialogueTurns(value: unknown, fallback: DialogueTurn[]): DialogueTurn[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const turns = value
    .map((turn, index) => {
      if (!turn || typeof turn !== 'object') {
        return null;
      }

      const candidate = turn as Partial<DialogueTurn>;
      const text = typeof candidate.text === 'string' ? candidate.text : '';
      const voice = typeof candidate.voice === 'string' && candidate.voice.trim() ? candidate.voice : `Speaker ${index + 1}`;
      if (!text.trim()) {
        return null;
      }

      return {
        id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : `turn-${index + 1}`,
        voice,
        text,
      };
    })
    .filter(Boolean) as DialogueTurn[];

  return turns.length > 0 ? turns : fallback;
}

function normalizeNumericValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getLegacyLanguageCode(data: VoiceoverGenerateNodeData | undefined): string | null {
  if (!data) return null;
  if (typeof data.languageCode === 'string') {
    return data.languageCode;
  }

  const legacy = data as VoiceoverGenerateNodeData & { language?: string };
  return typeof legacy.language === 'string' ? legacy.language : null;
}

export function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return ['text-input', 'image-input', 'video-input', 'audio-input', 'image-generate', 'video-generate', 'motion-generate', 'voiceover-generate', 'music-generate', 'sound-effects-generate', 'note', 'group'].includes(String(value));
}

export function isRunnableNode(node: WorkflowCanvasNode): boolean {
  return node.type === 'image-generate' || node.type === 'video-generate' || node.type === 'motion-generate' || node.type === 'voiceover-generate' || node.type === 'music-generate' || node.type === 'sound-effects-generate';
}

export function validateWorkflowConnection(sourceType: WorkflowHandleType | null | undefined, targetType: WorkflowHandleType | null | undefined): boolean {
  if (!sourceType || !targetType) return false;
  if (sourceType === 'text' && targetType === 'prompt') return true;
  if (sourceType === 'image' && (targetType === 'image-reference' || targetType === 'reference-image' || targetType === 'element-image' || targetType === 'start-frame' || targetType === 'end-frame' || targetType === 'image')) return true;
  if (sourceType === 'video' && targetType === 'reference-video') return true;
  return false;
}

export function getWorkflowNodeInputHandles(nodeKind: WorkflowNodeKind): WorkflowHandleType[] {
  return WORKFLOW_NODE_HANDLE_SCHEMAS[nodeKind]?.inputs ?? [];
}

export function getWorkflowNodeOutputHandles(nodeKind: WorkflowNodeKind): WorkflowHandleType[] {
  return WORKFLOW_NODE_HANDLE_SCHEMAS[nodeKind]?.outputs ?? [];
}

export function getPreferredWorkflowInputHandle(
  nodeKind: WorkflowNodeKind,
  sourceHandle: WorkflowHandleType
): WorkflowHandleType | null {
  const compatibleInput = getWorkflowNodeInputHandles(nodeKind)
    .find((targetHandle) => validateWorkflowConnection(sourceHandle, targetHandle));

  return compatibleInput ?? null;
}

export function getPreferredWorkflowOutputHandle(
  nodeKind: WorkflowNodeKind,
  targetHandle: WorkflowHandleType
): WorkflowHandleType | null {
  const compatibleOutput = getWorkflowNodeOutputHandles(nodeKind)
    .find((sourceHandle) => validateWorkflowConnection(sourceHandle, targetHandle));

  return compatibleOutput ?? null;
}

export function getCompatibleWorkflowNodeKindsForSourceHandle(
  sourceHandle: WorkflowHandleType
): WorkflowNodeKind[] {
  return Object.keys(WORKFLOW_NODE_HANDLE_SCHEMAS)
    .filter((nodeKind) => getPreferredWorkflowInputHandle(nodeKind as WorkflowNodeKind, sourceHandle))
    .map((nodeKind) => nodeKind as WorkflowNodeKind);
}

export function getCompatibleWorkflowNodeKindsForEdgeInsertion(
  sourceHandle: WorkflowHandleType,
  targetHandle: WorkflowHandleType
): WorkflowNodeKind[] {
  return getCompatibleWorkflowNodeKindsForSourceHandle(sourceHandle).filter((nodeKind) => {
    return Boolean(getPreferredWorkflowOutputHandle(nodeKind, targetHandle));
  });
}

export function getNodeById(graph: WorkflowCanvasGraph, nodeId: string): WorkflowCanvasNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

export function getIncomingEdges(graph: WorkflowCanvasGraph, nodeId: string): WorkflowCanvasEdge[] {
  return graph.edges.filter((edge) => edge.target === nodeId);
}

export function getOutgoingEdges(graph: WorkflowCanvasGraph, nodeId: string): WorkflowCanvasEdge[] {
  return graph.edges.filter((edge) => edge.source === nodeId);
}

export type WorkflowCapabilityIssueCode =
  | 'too-many-reference-images'
  | 'too-many-reference-videos'
  | 'reference-video-too-long'
  | 'too-many-start-frames'
  | 'too-many-end-frames'
  | 'too-many-elements'
  | 'duplicate-element-handles'
  | 'missing-element-sources'
  | 'frame-element-conflict'
  | 'unsupported-elements-mode'
  | 'unsupported-multi-shot'
  | 'end-frame-not-supported'
  | 'unknown-element-handles'
  | 'missing-shot-prompts';

export interface WorkflowCapabilityIssue {
  code: WorkflowCapabilityIssueCode;
  message: string;
}

export interface WorkflowNodeCapabilityValidation {
  isValid: boolean;
  issues: WorkflowCapabilityIssue[];
  referenceImageCount: number;
  referenceImageLimit: number | null;
  totalReferenceImageCount: number;
  referenceVideoCount: number;
  referenceVideoLimit: number | null;
  referenceVideoDurationLimitSeconds: number | null;
  connectedElementCount: number;
  legacyElementCount: number;
  namedElementCount: number;
  namedElementLimit: number | null;
  startFrameCount: number;
  endFrameCount: number;
  activeReferenceMode: 'frames' | 'references' | null;
  isMultiShot: boolean;
  multiPromptCount: number;
  unsupportedFeatureNotes: string[];
}

export interface WorkflowConnectionValidationResult {
  valid: boolean;
  message: string | null;
}

const WORKFLOW_MOTION_OUTPUT_DURATION_SECONDS = 10;

export type WorkflowPromptEnhancementMedium = 'image' | 'video' | 'motion';

type WorkflowPromptEnhancementNodeType = 'image-generate' | 'video-generate' | 'motion-generate';

export interface WorkflowPromptEnhancementTarget {
  nodeId: string;
  nodeType: WorkflowPromptEnhancementNodeType;
  medium: WorkflowPromptEnhancementMedium;
  depth: number;
}

export interface WorkflowPromptMentionCandidate {
  handle: string;
  displayName: string;
  branchLabels: string[];
  sourceCount: number;
}

const WORKFLOW_PROMPT_ENHANCEMENT_MEDIA: Record<
  WorkflowPromptEnhancementNodeType,
  WorkflowPromptEnhancementMedium
> = {
  'image-generate': 'image',
  'video-generate': 'video',
  'motion-generate': 'motion',
};

function isWorkflowPromptEnhancementNodeType(
  value: WorkflowNodeKind
): value is WorkflowPromptEnhancementNodeType {
  return value === 'image-generate' || value === 'video-generate' || value === 'motion-generate';
}

function isWorkflowPromptMentionNodeType(
  value: WorkflowNodeKind
): value is 'image-generate' | 'video-generate' {
  return value === 'image-generate' || value === 'video-generate';
}

export interface ResolvedWorkflowInputs extends Record<string, unknown> {
  prompt: string | null;
  imageReferences: ResolvedWorkflowImageReferenceInput[];
  videoUrls: string[];
  audioUrls: string[];
  startFrameUrl: string | null;
  endFrameUrl: string | null;
}

export interface ResolvedWorkflowImageReferenceInput {
  edgeId: string;
  sourceNodeId: string;
  sourceTitle: string;
  url: string | null;
  storagePath: string | null;
  sourceGenerationId: string | null;
}

export interface WorkflowResolvedImageReference {
  id: string;
  edgeId: string;
  handle: string | null;
  handleSource: 'source' | 'legacy-binding' | 'legacy-element' | null;
  displayName: string;
  url: string | null;
  storagePath: string | null;
  sourceGenerationId: string | null;
  sourceNodeId: string | null;
  sourceTitle: string;
  legacy: boolean;
}

export type WorkflowResolvedElementReference = WorkflowResolvedImageReference;

export interface WorkflowNodeDependencyState {
  kind: 'ready' | 'queued' | 'blocked';
  message: string | null;
}

function countIncomingEdgesForTargetHandle(
  graph: WorkflowCanvasGraph,
  nodeId: string,
  targetHandle: WorkflowHandleType
) {
  const targetNode = getNodeById(graph, nodeId);
  return getIncomingEdges(graph, nodeId)
    .filter((edge) => getNormalizedIncomingTargetHandle(edge, targetNode) === targetHandle)
    .length;
}

function getNormalizedIncomingTargetHandle(
  edge: WorkflowCanvasEdge,
  targetNode?: WorkflowCanvasNode
): WorkflowHandleType | null {
  if (!edge.targetHandle) {
    return null;
  }

  if (targetNode?.type === 'image-generate') {
    if (edge.targetHandle === 'reference-image' || edge.targetHandle === 'element-image') {
      return 'image-reference';
    }
  }

  if (targetNode?.type === 'video-generate') {
    if (edge.targetHandle === 'reference-image') {
      return 'start-frame';
    }

    if (edge.targetHandle === 'element-image') {
      return 'image-reference';
    }
  }

  return edge.targetHandle as WorkflowHandleType;
}

function getWorkflowElementSourceDisplayName(
  sourceNode: WorkflowCanvasNode | undefined,
  fallbackIndex: number
): string {
  const sourceTitle = sourceNode?.data?.title;
  return normalizeElementDisplayName(
    typeof sourceTitle === 'string' && sourceTitle.trim() ? sourceTitle : undefined,
    fallbackIndex
  );
}

function getWorkflowSourceReferenceHandle(
  sourceNode: WorkflowCanvasNode | undefined
): string | null {
  if (!sourceNode) {
    return null;
  }

  if (sourceNode.type === 'image-input') {
    const data = normalizeNodeData('image-input', sourceNode.data as Partial<WorkflowNodeData>) as ImageInputNodeData;
    return normalizeWorkflowReferenceHandle(data.referenceHandle);
  }

  if (sourceNode.type === 'image-generate') {
    const data = normalizeNodeData('image-generate', sourceNode.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData;
    return normalizeWorkflowReferenceHandle(data.referenceHandle);
  }

  return null;
}

function areReferenceBindingsEqual(
  left: WorkflowReferenceBinding[],
  right: WorkflowReferenceBinding[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.edgeId !== right[index]?.edgeId || left[index]?.handle !== right[index]?.handle) {
      return false;
    }
  }

  return true;
}

function syncNodeReferenceBindings(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode
): WorkflowCanvasNode {
  if (node.type !== 'image-generate' && node.type !== 'video-generate') {
    return node;
  }

  const data = normalizeNodeData(node.type, node.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData | VideoGenerateNodeData;
  const existingBindings = new Map(data.referenceBindings.map((binding) => [binding.edgeId, binding]));
  const reservedHandles = new Set(
    data.referenceBindings
      .map((binding) => normalizeWorkflowReferenceHandle(binding.handle))
      .filter((handle): handle is string => Boolean(handle))
  );
  const referenceEdges = getIncomingEdges(graph, node.id)
    .filter((edge) => getNormalizedIncomingTargetHandle(edge, node) === 'image-reference');

  const nextBindings = referenceEdges.map((edge, index) => {
    const existingBinding = existingBindings.get(edge.id);
    const normalizedExistingHandle = normalizeWorkflowReferenceHandle(existingBinding?.handle);
    const isLegacyNamedReference = edge.targetHandle === 'element-image';
    const handle = normalizedExistingHandle ?? (
      isLegacyNamedReference
        ? buildElementHandle(
            getWorkflowElementSourceDisplayName(getNodeById(graph, edge.source), index + 1),
            reservedHandles,
            index + 1
          )
        : null
    );

    return {
      edgeId: edge.id,
      handle,
    } satisfies WorkflowReferenceBinding;
  });

  if (areReferenceBindingsEqual(data.referenceBindings, nextBindings)) {
    return node;
  }

  return {
    ...node,
    data: normalizeNodeData(node.type, {
      ...data,
      referenceBindings: nextBindings,
    }),
  };
}

export function syncWorkflowGraphReferenceBindings(
  graph: WorkflowCanvasGraph
): WorkflowCanvasGraph {
  const nextNodes = graph.nodes.map((node) => syncNodeReferenceBindings(graph, node));
  const changed = nextNodes.some((node, index) => node !== graph.nodes[index]);

  return changed
    ? {
        ...graph,
        nodes: nextNodes,
      }
    : graph;
}

export function syncWorkflowGraphElementBindings(
  graph: WorkflowCanvasGraph
): WorkflowCanvasGraph {
  return syncWorkflowGraphReferenceBindings(graph);
}

export function getWorkflowReferenceElementDescriptors(
  elements: WorkflowReferenceElement[]
): ImageElementDescriptor[] {
  return elements.map((element) => ({
    id: element.id,
    displayName: element.displayName,
    handle: element.handle,
    storagePath: element.storagePath ?? null,
    sourceGenerationId: element.sourceGenerationId ?? null,
  }));
}

export function getWorkflowReferenceElementSourceUrl(
  element: WorkflowReferenceElement
): string | null {
  return element.storagePath || element.url || null;
}

export function getResolvedWorkflowImageReferences(
  graph: WorkflowCanvasGraph,
  nodeId: string
): WorkflowResolvedImageReference[] {
  const node = getNodeById(graph, nodeId);
  if (!node || (node.type !== 'image-generate' && node.type !== 'video-generate')) {
    return [];
  }

  const data = normalizeNodeData(node.type, node.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData | VideoGenerateNodeData;
  const resolvedInputs = resolveNodeInputs(graph, nodeId);
  const bindingByEdgeId = new Map(data.referenceBindings.map((binding) => [binding.edgeId, binding]));

  const connectedReferences = resolvedInputs.imageReferences.map((reference, index) => {
    const sourceNode = getNodeById(graph, reference.sourceNodeId);
    const binding = bindingByEdgeId.get(reference.edgeId);
    const displayName = getWorkflowElementSourceDisplayName(sourceNode, index + 1);
    const sourceHandle = getWorkflowSourceReferenceHandle(sourceNode);
    const legacyBindingHandle = normalizeWorkflowReferenceHandle(binding?.handle);
    const handle = sourceHandle ?? legacyBindingHandle;
    const handleSource = sourceHandle
      ? 'source'
      : legacyBindingHandle
        ? 'legacy-binding'
        : null;

    return {
      id: reference.edgeId,
      edgeId: reference.edgeId,
      handle,
      handleSource,
      displayName,
      url: reference.url,
      storagePath: reference.storagePath,
      sourceGenerationId: reference.sourceGenerationId,
      sourceNodeId: reference.sourceNodeId,
      sourceTitle: reference.sourceTitle,
      legacy: false,
    } satisfies WorkflowResolvedImageReference;
  });

  const legacyElements = data.elements.map((element) => ({
    id: element.id,
    edgeId: `legacy:${element.id}`,
    handle: element.handle,
    handleSource: 'legacy-element' as const,
    displayName: element.displayName,
    url: getWorkflowReferenceElementSourceUrl(element),
    storagePath: element.storagePath ?? null,
    sourceGenerationId: element.sourceGenerationId ?? null,
    sourceNodeId: null,
    sourceTitle: element.displayName,
    legacy: true,
  }) satisfies WorkflowResolvedImageReference);

  return [...connectedReferences, ...legacyElements];
}

export function getResolvedWorkflowElementReferences(
  graph: WorkflowCanvasGraph,
  nodeId: string
): WorkflowResolvedImageReference[] {
  return getResolvedWorkflowImageReferences(graph, nodeId);
}

function getKnownWorkflowSourceVideoDurationSeconds(node: WorkflowCanvasNode | undefined): number | null {
  if (!node) {
    return null;
  }

  if (node.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    return data.isMultiShot
      ? data.multiPrompts.reduce((total, shot) => total + (shot.duration || 0), 0)
      : data.duration;
  }

  if (node.type === 'motion-generate') {
    return WORKFLOW_MOTION_OUTPUT_DURATION_SECONDS;
  }

  if (node.type === 'video-input') {
    const data = normalizeNodeData('video-input', node.data as Partial<WorkflowNodeData>) as VideoInputNodeData;
    return data.durationSeconds;
  }

  return null;
}

function getConnectedPromptText(graph: WorkflowCanvasGraph, nodeId: string): string | null {
  const promptParts: string[] = [];

  for (const edge of getIncomingEdges(graph, nodeId)) {
    if (edge.sourceHandle !== 'text') {
      continue;
    }

    const source = getNodeById(graph, edge.source);
    if (!source || !('text' in source.data) || typeof source.data.text !== 'string') {
      continue;
    }

    const nextPrompt = source.data.text.trim();
    if (nextPrompt) {
      promptParts.push(nextPrompt);
    }
  }

  return promptParts.filter(Boolean).join('\n\n') || null;
}

function buildUnknownHandleIssueMessage(params: {
  handles: string[];
  validHandles: string[];
  mediumLabel: 'image' | 'video';
  referenceMode?: 'frames' | 'references';
  isMultiShot?: boolean;
}): string {
  const { handles, validHandles, mediumLabel, referenceMode, isMultiShot } = params;
  const handleLabel = handles.join(', ');

  if (isMultiShot) {
    return `Shot prompts mention ${handleLabel}, but multi-shot runs do not use named elements. Remove the @handles from the shot prompts.`;
  }

  if (referenceMode === 'frames') {
    return `This ${mediumLabel} prompt mentions ${handleLabel}, but the node is currently using Frames mode. Remove the frame connections or remove the @handles.`;
  }

  if (validHandles.length === 0) {
    return `This ${mediumLabel} prompt mentions ${handleLabel}, but no handled image references are attached to this node yet. Add @handles on the matching source image nodes or remove the @handles.`;
  }

  return `This ${mediumLabel} prompt mentions ${handleLabel}, but this node only has ${validHandles.join(', ')} available. Add @handles on the matching source image nodes or remove the @handles.`;
}

function findDuplicateHandles(handles: string[]): string[] {
  const counts = new Map<string, number>();

  handles.forEach((handle) => {
    counts.set(handle, (counts.get(handle) || 0) + 1);
  });

  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([handle]) => handle);
}

export function inspectWorkflowNodeCapabilities(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode
): WorkflowNodeCapabilityValidation {
  let referenceImageCount = countIncomingEdgesForTargetHandle(graph, node.id, 'image-reference');
  let connectedElementCount = 0;
  const referenceVideoCount = countIncomingEdgesForTargetHandle(graph, node.id, 'reference-video');
  const startFrameCount = countIncomingEdgesForTargetHandle(graph, node.id, 'start-frame');
  const endFrameCount = countIncomingEdgesForTargetHandle(graph, node.id, 'end-frame');
  const issues: WorkflowCapabilityIssue[] = [];
  let referenceImageLimit: number | null = null;
  let referenceVideoLimit: number | null = null;
  let referenceVideoDurationLimitSeconds: number | null = null;
  let totalReferenceImageCount = referenceImageCount;
  let legacyElementCount = 0;
  let namedElementCount = 0;
  let namedElementLimit: number | null = null;
  let activeReferenceMode: 'frames' | 'references' | null = null;
  let isMultiShot = false;
  let multiPromptCount = 0;
  let unsupportedFeatureNotes: string[] = [];
  const connectedPrompt = getConnectedPromptText(graph, node.id);
  const resolvedImageReferences = getResolvedWorkflowImageReferences(graph, node.id);
  const connectedImageReferences = resolvedImageReferences.filter((reference) => !reference.legacy);
  const handledReferences = resolvedImageReferences.filter((reference) => Boolean(reference.handle));
  const connectedHandledReferences = connectedImageReferences.filter((reference) => Boolean(reference.handle));
  const handledReferenceHandles = handledReferences
    .map((reference) => reference.handle)
    .filter((handle): handle is string => Boolean(handle));

  if (node.type === 'image-generate') {
    const data = normalizeNodeData('image-generate', node.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData;
    const model = IMAGE_MODELS[data.model];
    legacyElementCount = data.elements.length;
    referenceImageCount = countIncomingEdgesForTargetHandle(graph, node.id, 'image-reference');
    connectedElementCount = connectedHandledReferences.length;
    namedElementCount = connectedHandledReferences.length + legacyElementCount;
    referenceImageLimit = model.maxImages;
    totalReferenceImageCount = referenceImageCount + legacyElementCount;
    namedElementLimit = model.maxImages;
    activeReferenceMode = totalReferenceImageCount > 0 ? 'references' : null;
    unsupportedFeatureNotes = [
      `All connected image references share the ${model.maxImages}-image budget for ${model.displayName}.`,
      handledReferenceHandles.length > 0
        ? 'Only references whose source image nodes have handles are compiled into the prompt. Leave the source handle blank when you only want visual guidance.'
        : 'Add an optional @handle on any connected image source when you want the prompt to address it directly.',
    ];

    if (totalReferenceImageCount > model.maxImages) {
      issues.push({
        code: 'too-many-reference-images',
        message: `${model.displayName} supports up to ${model.maxImages} total image references in workflows. Remove extra references to run this node.`,
      });
    }

    if (connectedImageReferences.some((reference) => !reference.url)) {
      issues.push({
        code: 'missing-element-sources',
        message: 'A connected image reference does not have an image output yet. Run or upload the upstream image source before continuing.',
      });
    }

    const duplicateHandles = findDuplicateHandles(handledReferenceHandles);
    if (duplicateHandles.length > 0) {
      issues.push({
        code: 'duplicate-element-handles',
        message: `Reference handles must be unique per node. Update ${duplicateHandles.join(', ')} to continue.`,
      });
    }

    const unknownHandles = connectedPrompt
      ? findUnknownPromptHandles(connectedPrompt, handledReferenceHandles)
      : [];
    if (unknownHandles.length > 0) {
      issues.push({
        code: 'unknown-element-handles',
        message: buildUnknownHandleIssueMessage({
          handles: unknownHandles,
          validHandles: handledReferenceHandles,
          mediumLabel: 'image',
        }),
      });
    }
  }

  if (node.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    const model = VIDEO_MODELS[data.model];
    const videoElementSupport = getVideoElementSupport(data.model, {
      mode: data.mode,
      isMultiShot: data.isMultiShot,
    });
    const singleShotPrompt = connectedPrompt || '';
    const multiShotPrompt = data.multiPrompts.map((shot) => shot.prompt.trim()).filter(Boolean).join('\n\n');
    const promptToInspect = data.isMultiShot ? multiShotPrompt : singleShotPrompt;
    legacyElementCount = data.elements.length;
    referenceImageCount = countIncomingEdgesForTargetHandle(graph, node.id, 'image-reference');
    connectedElementCount = connectedHandledReferences.length;
    totalReferenceImageCount = referenceImageCount + legacyElementCount;
    const handledReferenceCount = connectedElementCount + legacyElementCount;
    namedElementCount = handledReferenceCount;
    namedElementLimit = videoElementSupport.maxElements;
    activeReferenceMode = data.isMultiShot
      ? 'frames'
      : totalReferenceImageCount > 0
        ? 'references'
        : (startFrameCount > 0 || endFrameCount > 0 ? 'frames' : null);
    isMultiShot = data.isMultiShot;
    multiPromptCount = data.multiPrompts.length;
    referenceImageLimit = data.isMultiShot ? 0 : videoElementSupport.maxElements;
    unsupportedFeatureNotes = [
      'Workflow video nodes use the graph-connected Start frame and End frame handles for new authoring.',
      data.isMultiShot
        ? 'Multi-shot owns its shot prompts locally and ignores any connected upstream prompt text.'
        : 'Single-shot video uses the shared upstream prompt text unless you switch into multi-shot.',
      data.isMultiShot
        ? 'Multi-shot allows an optional start frame only. End frames stay disabled in this mode.'
        : totalReferenceImageCount > 0
          ? 'This node still has legacy general image references attached. New workflow video nodes should use Start frame and End frame instead.'
          : 'Connect Start frame for first-frame guidance, then add End frame when you want the video to land on a second frame.',
    ];

    if (startFrameCount > 1) {
      issues.push({
        code: 'too-many-start-frames',
        message: 'Workflow video nodes support only 1 start frame. Remove extra start-frame image connections to continue.',
      });
    }

    if (endFrameCount > 1) {
      issues.push({
        code: 'too-many-end-frames',
        message: 'Workflow video nodes support only 1 end frame. Remove extra end-frame image connections to continue.',
      });
    }

    if (data.isMultiShot && !model.supportsMultiShot) {
      issues.push({
        code: 'unsupported-multi-shot',
        message: `${model.displayName} does not support multi-shot video generation. Switch back to single-shot or choose a multi-shot-capable model.`,
      });
    }

    if (data.isMultiShot && endFrameCount > 0) {
      issues.push({
        code: 'end-frame-not-supported',
        message: 'End frames are not available in workflow multi-shot mode. Remove the end-frame connection or switch back to single-shot.',
      });
    }

    if (data.isMultiShot && data.multiPrompts.some((shot) => !shot.prompt.trim())) {
      issues.push({
        code: 'missing-shot-prompts',
        message: 'Every multi-shot entry needs its own prompt before this video node can run.',
      });
    }

    if (data.isMultiShot && totalReferenceImageCount > 0) {
      issues.push({
        code: 'unsupported-elements-mode',
        message: 'Image references are not available while this video node is in multi-shot mode. Remove them or switch back to single-shot.',
      });
    }

    if (!data.isMultiShot && totalReferenceImageCount > 0 && !videoElementSupport.enabled) {
      issues.push({
        code: 'unsupported-elements-mode',
        message: videoElementSupport.reason || 'Image references are not available in this video mode.',
      });
    }

    if (!data.isMultiShot && totalReferenceImageCount > videoElementSupport.maxElements) {
      issues.push({
        code: 'too-many-reference-images',
        message: `This video mode supports up to ${videoElementSupport.maxElements} image reference${videoElementSupport.maxElements === 1 ? '' : 's'}. Remove extra references to run this node.`,
      });
    }

    if (connectedImageReferences.some((reference) => !reference.url)) {
      issues.push({
        code: 'missing-element-sources',
        message: 'A connected image reference does not have an image output yet. Run or upload the upstream image source before continuing.',
      });
    }

    const duplicateHandles = findDuplicateHandles(handledReferenceHandles);
    if (duplicateHandles.length > 0) {
      issues.push({
        code: 'duplicate-element-handles',
        message: `Reference handles must be unique per node. Update ${duplicateHandles.join(', ')} to continue.`,
      });
    }

    if (totalReferenceImageCount > 0 && (startFrameCount > 0 || endFrameCount > 0)) {
      issues.push({
        code: 'frame-element-conflict',
        message: 'Image references cannot run together with start or end frames in the same video node. Keep one mode active at a time.',
      });
    }

    const unknownHandles = promptToInspect
      ? findUnknownPromptHandles(promptToInspect, handledReferenceHandles)
      : [];
    if (unknownHandles.length > 0) {
      issues.push({
        code: 'unknown-element-handles',
        message: buildUnknownHandleIssueMessage({
          handles: unknownHandles,
          validHandles: handledReferenceHandles,
          mediumLabel: 'video',
          referenceMode: activeReferenceMode ?? undefined,
          isMultiShot: data.isMultiShot,
        }),
      });
    }
  }

  if (node.type === 'motion-generate') {
    const data = normalizeNodeData('motion-generate', node.data as Partial<WorkflowNodeData>) as MotionGenerateNodeData;
    const model = MOTION_MODELS[data.model];
    referenceImageCount = countIncomingEdgesForTargetHandle(graph, node.id, 'reference-image');
    referenceImageLimit = 1;
    referenceVideoLimit = 1;
    referenceVideoDurationLimitSeconds = model.maxDuration;

    if (referenceImageCount > referenceImageLimit) {
      issues.push({
        code: 'too-many-reference-images',
        message: 'Motion control supports exactly 1 reference image in workflows. Remove extra image connections to run this node.',
      });
    }

    if (referenceVideoCount > referenceVideoLimit) {
      issues.push({
        code: 'too-many-reference-videos',
        message: 'Motion control supports exactly 1 reference video in workflows. Remove extra video connections to run this node.',
      });
    }

    for (const edge of getIncomingEdges(graph, node.id)) {
      if (edge.targetHandle !== 'reference-video') {
        continue;
      }

      const sourceNode = getNodeById(graph, edge.source);
      const durationSeconds = getKnownWorkflowSourceVideoDurationSeconds(sourceNode);
      if (typeof durationSeconds !== 'number' || durationSeconds <= model.maxDuration) {
        continue;
      }

      issues.push({
        code: 'reference-video-too-long',
        message: `${sourceNode?.data.title || 'Reference video'} exceeds the ${model.maxDuration}s motion-control limit for ${model.displayName}. Use a shorter clip or a different reference branch.`,
      });
      break;
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
    referenceImageCount,
    referenceImageLimit,
    totalReferenceImageCount,
    referenceVideoCount,
    referenceVideoLimit,
    referenceVideoDurationLimitSeconds,
    connectedElementCount,
    legacyElementCount,
    namedElementCount,
    namedElementLimit,
    startFrameCount,
    endFrameCount,
    activeReferenceMode,
    isMultiShot,
    multiPromptCount,
    unsupportedFeatureNotes,
  };
}

export function validateWorkflowConnectionForGraph(params: {
  graph: WorkflowCanvasGraph;
  sourceNodeId: string | null | undefined;
  sourceHandle: WorkflowHandleType | null | undefined;
  targetNodeId: string | null | undefined;
  targetHandle: WorkflowHandleType | null | undefined;
}): WorkflowConnectionValidationResult {
  const {
    graph,
    sourceNodeId,
    sourceHandle,
    targetNodeId,
    targetHandle,
  } = params;

  if (!sourceNodeId || !targetNodeId || !validateWorkflowConnection(sourceHandle, targetHandle)) {
    return {
      valid: false,
      message: 'That connection is not supported. Try matching prompt, image, or video handles.',
    };
  }

  if (sourceNodeId === targetNodeId) {
    return {
      valid: false,
      message: 'Connect this node to a different node.',
    };
  }

  const targetNode = getNodeById(graph, targetNodeId);
  if (!targetNode) {
    return {
      valid: false,
      message: 'That target node is no longer available.',
    };
  }

  const existingExactMatch = graph.edges.some((edge) =>
    edge.source === sourceNodeId &&
    edge.target === targetNodeId &&
    edge.sourceHandle === sourceHandle &&
    edge.targetHandle === targetHandle
  );

  if (existingExactMatch) {
    return {
      valid: false,
      message: 'That connection already exists.',
    };
  }

  const normalizedTargetHandle = getNormalizedIncomingTargetHandle(
    {
      id: '',
      source: sourceNodeId,
      target: targetNodeId,
      sourceHandle,
      targetHandle,
    },
    targetNode
  );

  if (normalizedTargetHandle === 'image-reference') {
    if (targetNode.type === 'image-generate') {
      const data = normalizeNodeData('image-generate', targetNode.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData;
      const totalImageBudget = countIncomingEdgesForTargetHandle(graph, targetNodeId, 'image-reference') + data.elements.length;
      const maxImages = IMAGE_MODELS[data.model].maxImages;

      if (totalImageBudget >= maxImages) {
        return {
          valid: false,
          message: `${IMAGE_MODELS[data.model].displayName} supports up to ${maxImages} total image references in workflows.`,
        };
      }
    }

    if (targetNode.type === 'video-generate') {
      return {
        valid: false,
        message: 'Workflow video nodes now use Start frame and optional End frame instead of general image references.',
      };
    }
  }

  if (normalizedTargetHandle === 'reference-image') {
    const currentCount = countIncomingEdgesForTargetHandle(graph, targetNodeId, 'reference-image');

    if (targetNode.type === 'motion-generate' && currentCount >= 1) {
      return {
        valid: false,
        message: 'Motion control supports exactly 1 reference image in workflows.',
      };
    }
  }

  if (targetNode.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', targetNode.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;

    if (normalizedTargetHandle === 'start-frame') {
      if (countIncomingEdgesForTargetHandle(graph, targetNodeId, 'image-reference') + data.elements.length > 0) {
        return {
          valid: false,
          message: 'This video node already has connected image references. Remove them before adding a start frame.',
        };
      }

      const currentCount = countIncomingEdgesForTargetHandle(graph, targetNodeId, 'start-frame');
      if (currentCount >= 1) {
        return {
          valid: false,
          message: 'Workflow video nodes support only 1 start frame.',
        };
      }
    }

    if (normalizedTargetHandle === 'end-frame') {
      if (countIncomingEdgesForTargetHandle(graph, targetNodeId, 'image-reference') + data.elements.length > 0) {
        return {
          valid: false,
          message: 'This video node already has connected image references. Remove them before adding an end frame.',
        };
      }

      if (data.isMultiShot) {
        return {
          valid: false,
          message: 'End frames are not available while this video node is in multi-shot mode.',
        };
      }

      const currentCount = countIncomingEdgesForTargetHandle(graph, targetNodeId, 'end-frame');
      if (currentCount >= 1) {
        return {
          valid: false,
          message: 'Workflow video nodes support only 1 end frame.',
        };
      }
    }
  }

  if (targetHandle === 'reference-video' && targetNode.type === 'motion-generate') {
    const currentCount = countIncomingEdgesForTargetHandle(graph, targetNodeId, 'reference-video');
    if (currentCount >= 1) {
      return {
        valid: false,
        message: 'Motion control supports exactly 1 reference video in workflows.',
      };
    }
  }

  return { valid: true, message: null };
}

export function getPromptEnhancementTargets(
  graph: WorkflowCanvasGraph,
  promptNodeId: string
): WorkflowPromptEnhancementTarget[] {
  const startNode = getNodeById(graph, promptNodeId);
  if (!startNode || startNode.type !== 'text-input') {
    return [];
  }

  const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: promptNodeId, depth: 0 }];
  const visitedNodeIds = new Set<string>();
  const seenTargetNodeIds = new Set<string>();
  const targets: WorkflowPromptEnhancementTarget[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current || visitedNodeIds.has(current.nodeId)) {
      continue;
    }

    visitedNodeIds.add(current.nodeId);

    for (const edge of getOutgoingEdges(graph, current.nodeId)) {
      const nextNode = getNodeById(graph, edge.target);
      if (!nextNode) {
        continue;
      }

      queue.push({ nodeId: nextNode.id, depth: current.depth + 1 });

      if (!isWorkflowPromptEnhancementNodeType(nextNode.type) || seenTargetNodeIds.has(nextNode.id)) {
        continue;
      }

      if (nextNode.type === 'video-generate') {
        const videoData = normalizeNodeData(
          'video-generate',
          nextNode.data as Partial<WorkflowNodeData>
        ) as VideoGenerateNodeData;
        if (videoData.isMultiShot) {
          continue;
        }
      }

      seenTargetNodeIds.add(nextNode.id);
      targets.push({
        nodeId: nextNode.id,
        nodeType: nextNode.type,
        medium: WORKFLOW_PROMPT_ENHANCEMENT_MEDIA[nextNode.type],
        depth: current.depth + 1,
      });
    }
  }

  return targets;
}

function getPromptMentionBranchLabel(node: WorkflowCanvasNode): string {
  if (node.type === 'image-generate') {
    const data = normalizeNodeData('image-generate', node.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData;
    return `${data.title} (${IMAGE_MODELS[data.model].displayName})`;
  }

  const data = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
  return `${data.title} (${VIDEO_MODELS[data.model].displayName})`;
}

function getPromptMentionableReferencesForNode(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode
): WorkflowResolvedImageReference[] {
  if (!isWorkflowPromptMentionNodeType(node.type)) {
    return [];
  }

  if (node.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    const capabilityValidation = inspectWorkflowNodeCapabilities(graph, node);

    if (
      data.isMultiShot
      || capabilityValidation.startFrameCount > 0
      || capabilityValidation.endFrameCount > 0
      || capabilityValidation.issues.some((issue) =>
        issue.code === 'unsupported-elements-mode' || issue.code === 'frame-element-conflict')
    ) {
      return [];
    }
  }

  const resolvedReferences = getResolvedWorkflowImageReferences(graph, node.id)
    .filter((reference) => !reference.legacy && Boolean(reference.handle) && Boolean(reference.url));
  const handleCounts = new Map<string, number>();

  resolvedReferences.forEach((reference) => {
    if (!reference.handle) {
      return;
    }

    handleCounts.set(reference.handle, (handleCounts.get(reference.handle) || 0) + 1);
  });

  return resolvedReferences.filter((reference) => {
    if (!reference.handle) {
      return false;
    }

    return handleCounts.get(reference.handle) === 1;
  });
}

export function getWorkflowPromptMentionCandidates(
  graph: WorkflowCanvasGraph,
  promptNodeId: string
): WorkflowPromptMentionCandidate[] {
  const startNode = getNodeById(graph, promptNodeId);
  if (!startNode || startNode.type !== 'text-input') {
    return [];
  }

  const queue: string[] = [promptNodeId];
  const visitedNodeIds = new Set<string>();
  const mentionByHandle = new Map<string, {
    handle: string;
    displayName: string;
    branchLabels: Set<string>;
  }>();

  for (let index = 0; index < queue.length; index += 1) {
    const currentNodeId = queue[index];
    if (!currentNodeId || visitedNodeIds.has(currentNodeId)) {
      continue;
    }

    visitedNodeIds.add(currentNodeId);

    for (const edge of getOutgoingEdges(graph, currentNodeId)) {
      const nextNode = getNodeById(graph, edge.target);
      if (!nextNode) {
        continue;
      }

      queue.push(nextNode.id);

      if (!isWorkflowPromptMentionNodeType(nextNode.type)) {
        continue;
      }

      if (nextNode.type === 'video-generate') {
        continue;
      }

      const branchLabel = getPromptMentionBranchLabel(nextNode);
      const references = getPromptMentionableReferencesForNode(graph, nextNode);

      references.forEach((reference) => {
        if (!reference.handle) {
          return;
        }

        const existing = mentionByHandle.get(reference.handle);
        if (existing) {
          existing.branchLabels.add(branchLabel);
          return;
        }

        mentionByHandle.set(reference.handle, {
          handle: reference.handle,
          displayName: reference.displayName,
          branchLabels: new Set([branchLabel]),
        });
      });
    }
  }

  return Array.from(mentionByHandle.values())
    .map((candidate) => ({
      handle: candidate.handle,
      displayName: candidate.displayName,
      branchLabels: Array.from(candidate.branchLabels).sort((left, right) => left.localeCompare(right)),
      sourceCount: candidate.branchLabels.size,
    }))
    .sort((left, right) => left.handle.localeCompare(right.handle));
}

export function resolveNodeInputs(graph: WorkflowCanvasGraph, nodeId: string): ResolvedWorkflowInputs {
  const incoming = getIncomingEdges(graph, nodeId);
  const targetNode = getNodeById(graph, nodeId);
  const promptParts: string[] = [];
  const imageReferences: ResolvedWorkflowImageReferenceInput[] = [];
  const videoUrls: string[] = [];
  const audioUrls: string[] = [];
  let startFrameUrl: string | null = null;
  let endFrameUrl: string | null = null;

  for (const edge of incoming) {
    const source = getNodeById(graph, edge.source);
    if (!source) continue;
    const sourceData = source.data;
    const normalizedTargetHandle = getNormalizedIncomingTargetHandle(edge, targetNode);

    if (edge.sourceHandle === 'text' && 'text' in sourceData && typeof sourceData.text === 'string') {
      promptParts.push(sourceData.text.trim());
    }

    if (edge.sourceHandle === 'image') {
      const url = getNodeOutputUrl(source);
      if (normalizedTargetHandle === 'image-reference' || normalizedTargetHandle === 'reference-image') {
        const sourceData = source.data as Partial<ImageInputNodeData> & { runState?: Partial<WorkflowNodeRunState> };
        imageReferences.push({
          edgeId: edge.id,
          sourceNodeId: source.id,
          sourceTitle: getWorkflowElementSourceDisplayName(source, imageReferences.length + 1),
          url,
          storagePath: source.type === 'image-input' && typeof sourceData.storagePath === 'string'
            ? sourceData.storagePath
            : null,
          sourceGenerationId: typeof sourceData.runState?.generationId === 'string'
            ? sourceData.runState.generationId
            : null,
        });
      } else if (url) {
        if (normalizedTargetHandle === 'start-frame') {
          startFrameUrl ||= url;
        } else if (normalizedTargetHandle === 'end-frame') {
          endFrameUrl ||= url;
        }
      }
    }

    if (edge.sourceHandle === 'video') {
      const url = getNodeOutputUrl(source);
      if (url) videoUrls.push(url);
    }

    if (edge.sourceHandle === 'audio') {
      const url = getNodeOutputUrl(source);
      if (url) audioUrls.push(url);
    }
  }

  return {
    prompt: promptParts.filter(Boolean).join('\n\n') || null,
    imageReferences,
    videoUrls,
    audioUrls,
    startFrameUrl,
    endFrameUrl,
  };
}

export function getNodeOutputUrl(node: WorkflowCanvasNode): string | null {
  const data = node.data;
  if (node.type === 'image-input') {
    return (data as ImageInputNodeData).imageUrl;
  }
  if (node.type === 'video-input') {
    return (data as VideoInputNodeData).videoUrl;
  }
  if (node.type === 'audio-input') {
    return (data as AudioInputNodeData).audioUrl;
  }
  return data.runState.outputUrl;
}

export function inspectWorkflowNodeDependencies(
  graph: WorkflowCanvasGraph,
  node: WorkflowCanvasNode
): WorkflowNodeDependencyState {
  const capabilityValidation = inspectWorkflowNodeCapabilities(graph, node);
  const resolvedInputs = resolveNodeInputs(graph, node.id);
  if (!capabilityValidation.isValid) {
    return {
      kind: 'blocked',
      message: capabilityValidation.issues[0]?.message || 'This node has unsupported workflow settings.',
    };
  }

  if (node.type === 'image-generate' && !resolvedInputs.prompt?.trim()) {
    return {
      kind: 'blocked',
      message: 'Image generator is missing a prompt input.',
    };
  }

  if (node.type === 'video-generate' && !capabilityValidation.isMultiShot && !resolvedInputs.prompt?.trim()) {
    return {
      kind: 'blocked',
      message: 'Video generator is missing a prompt input.',
    };
  }

  const waitingMessages: string[] = [];
  const blockingMessages: string[] = [];

  for (const edge of getIncomingEdges(graph, node.id)) {
    const source = getNodeById(graph, edge.source);
    if (!source) continue;

    const sourceTitle = source.data.title || source.id;

    if (edge.sourceHandle === 'text') {
      if (node.type === 'video-generate' && capabilityValidation.isMultiShot) {
        continue;
      }

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

export function getExecutionOrder(graph: WorkflowCanvasGraph, startNodeId: string, mode: 'node' | 'branch'): string[] {
  if (mode === 'node') return [startNodeId];

  const reachable = new Set<string>();
  const queue = [startNodeId];

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex];
    if (!current || reachable.has(current)) continue;
    reachable.add(current);

    for (const edge of getOutgoingEdges(graph, current)) {
      if (!reachable.has(edge.target)) {
        queue.push(edge.target);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const outgoingMap = new Map<string, string[]>();

  for (const nodeId of reachable) {
    inDegree.set(nodeId, 0);
    outgoingMap.set(nodeId, []);
  }

  for (const edge of graph.edges) {
    if (!reachable.has(edge.source) || !reachable.has(edge.target)) continue;
    outgoingMap.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }

  const ready: string[] = Array.from(reachable).filter((nodeId) => (inDegree.get(nodeId) || 0) === 0);
  ready.sort((left, right) => {
    if (left === startNodeId) return -1;
    if (right === startNodeId) return 1;
    return left.localeCompare(right);
  });

  const ordered: string[] = [];
  const orderedNodeIds = new Set<string>();
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    ordered.push(nodeId);
    orderedNodeIds.add(nodeId);

    for (const target of outgoingMap.get(nodeId) || []) {
      const nextDegree = (inDegree.get(target) || 0) - 1;
      inDegree.set(target, nextDegree);
      if (nextDegree === 0) {
        ready.push(target);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  for (const nodeId of reachable) {
    if (!orderedNodeIds.has(nodeId)) {
      ordered.push(nodeId);
    }
  }

  return ordered;
}

export function getBranchNodeIds(graph: WorkflowCanvasGraph, startNodeId: string): string[] {
  return getExecutionOrder(graph, startNodeId, 'branch');
}

export function tidyWorkflowGraph(
  graph: WorkflowCanvasGraph,
  nodeIds?: string[]
): WorkflowCanvasGraph {
  const idsToTidy = nodeIds && nodeIds.length > 0
    ? new Set(nodeIds)
    : new Set(graph.nodes.map((node) => node.id));
  const tidyNodes = graph.nodes
    .filter((node) => idsToTidy.has(node.id))
    .sort((left, right) => {
      if (left.position.x !== right.position.x) {
        return left.position.x - right.position.x;
      }

      return left.position.y - right.position.y;
    });

  if (tidyNodes.length === 0) {
    return graph;
  }

  const nextPositions = new Map<string, { x: number; y: number }>();
  const originX = Math.min(...tidyNodes.map((node) => node.position.x));
  const originY = Math.min(...tidyNodes.map((node) => node.position.y));

  tidyNodes.forEach((node, index) => {
    const column = Math.floor(index / 3);
    const row = index % 3;
    nextPositions.set(node.id, {
      x: originX + column * 340,
      y: originY + row * 200,
    });
  });

  return {
    ...graph,
    nodes: graph.nodes.map((node) => (
      nextPositions.has(node.id)
        ? {
            ...node,
            position: nextPositions.get(node.id)!,
          }
        : node
    )),
  };
}

export function updateNodeRunState(
  graph: WorkflowCanvasGraph,
  nodeId: string,
  nextRunState: Partial<WorkflowNodeRunState>
): WorkflowCanvasGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            data: normalizeNodeData(node.type, {
              ...node.data,
              runState: createNodeRunState({
                ...node.data.runState,
                ...nextRunState,
              }),
            }),
          }
        : node
    ),
  };
}

export interface DuplicateWorkflowSelectionResult {
  duplicatedNodes: WorkflowCanvasNode[];
  duplicatedEdges: WorkflowCanvasEdge[];
  nodeIdMap: Record<string, string>;
}

export function duplicateWorkflowSelection(
  graph: Pick<WorkflowCanvasGraph, 'nodes' | 'edges'>,
  selectedNodeIds: string[],
  positionOffset: { x: number; y: number } = { x: 80, y: 80 }
): DuplicateWorkflowSelectionResult {
  const nodeIdSet = new Set(selectedNodeIds);
  const sourceNodes = graph.nodes.filter((node) => nodeIdSet.has(node.id));
  const nodeIdMap = Object.fromEntries(
    sourceNodes.map((node) => [node.id, `${node.type}-${crypto.randomUUID()}`])
  );

  const edgeIdMap: Record<string, string> = {};
  const duplicatedEdges = graph.edges
    .filter((edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target))
    .map((edge) => {
      const nextEdgeId = `edge-${crypto.randomUUID()}`;
      edgeIdMap[edge.id] = nextEdgeId;
      return {
        ...edge,
        id: nextEdgeId,
        source: nodeIdMap[edge.source],
        target: nodeIdMap[edge.target],
        selected: false,
      };
    });

  const duplicatedNodes = sourceNodes.map((node) => {
    const normalizedData = normalizeNodeData(node.type, {
      ...node.data,
      runState: createNodeRunState(),
    });

    if (node.type === 'image-generate' || node.type === 'video-generate') {
      const typedData = normalizedData as ImageGenerateNodeData | VideoGenerateNodeData;
      return {
        ...node,
        id: nodeIdMap[node.id],
        position: {
          x: node.position.x + positionOffset.x,
          y: node.position.y + positionOffset.y,
        },
        selected: false,
        data: normalizeNodeData(node.type, {
          ...typedData,
          referenceBindings: typedData.referenceBindings
            .filter((binding) => edgeIdMap[binding.edgeId])
            .map((binding) => ({
              ...binding,
              edgeId: edgeIdMap[binding.edgeId],
            })),
        }),
      };
    }

    return {
      ...node,
      id: nodeIdMap[node.id],
      position: {
        x: node.position.x + positionOffset.x,
        y: node.position.y + positionOffset.y,
      },
      selected: false,
      data: normalizedData,
    };
  });

  return {
    duplicatedNodes,
    duplicatedEdges,
    nodeIdMap,
  };
}
