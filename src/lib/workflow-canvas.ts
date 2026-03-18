import type { Edge, Node, Viewport } from '@xyflow/react';
import type { SoundEffectModelId, VoiceoverModelId } from '@/lib/models';

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
}

export interface VideoInputNodeData extends BaseWorkflowNodeData {
  videoUrl: string | null;
  storagePath: string | null;
}

export interface AudioInputNodeData extends BaseWorkflowNodeData {
  audioUrl: string | null;
  storagePath: string | null;
}

export interface ImageGenerateNodeData extends BaseWorkflowNodeData {
  model: 'nano-banana-2' | 'nano-banana-pro';
  aspectRatio: string;
  resolution: '1K' | '2K' | '4K';
  outputFormat: 'jpg' | 'png';
  googleSearch: boolean;
}

export interface VideoGenerateNodeData extends BaseWorkflowNodeData {
  model: 'kling-3.0-video' | 'seedance-1.5-pro' | 'veo-3.1';
  aspectRatio: string;
  duration: number;
  mode: string;
  sound: boolean;
  resolution: string;
  fixedLens: boolean;
}

export interface MotionGenerateNodeData extends BaseWorkflowNodeData {
  model: 'kling-2.6' | 'kling-3.0';
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

export interface WorkflowCanvasRecord {
  id: string;
  title: string;
  graph: WorkflowCanvasGraph;
  created_at: string;
  updated_at: string;
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

export const EMPTY_RUN_STATE: WorkflowNodeRunState = {
  status: 'idle',
  generationId: null,
  outputUrl: null,
  error: null,
  cost: null,
  updatedAt: null,
};

export function createNodeRunState(overrides?: Partial<WorkflowNodeRunState>): WorkflowNodeRunState {
  return { ...EMPTY_RUN_STATE, ...overrides };
}

export function createNodeData(type: WorkflowNodeKind): WorkflowNodeData {
  switch (type) {
    case 'text-input':
      return { title: 'Prompt', subtitle: 'Text input', text: 'Describe the scene, offer, or instruction here.', runState: createNodeRunState() };
    case 'image-input':
      return { title: 'Image input', subtitle: 'Upload or connect image', imageUrl: null, storagePath: null, runState: createNodeRunState() };
    case 'video-input':
      return { title: 'Video input', subtitle: 'Upload or connect video', videoUrl: null, storagePath: null, runState: createNodeRunState() };
    case 'audio-input':
      return { title: 'Audio input', subtitle: 'Upload or connect audio', audioUrl: null, storagePath: null, runState: createNodeRunState() };
    case 'image-generate':
      return {
        title: 'Image generator',
        subtitle: 'Nano Banana',
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        resolution: '1K',
        outputFormat: 'jpg',
        googleSearch: false,
        runState: createNodeRunState(),
      };
    case 'video-generate':
      return {
        title: 'Video generator',
        subtitle: 'Kling / Seedance / Veo',
        model: 'kling-3.0-video',
        aspectRatio: '9:16',
        duration: 5,
        mode: 'std',
        sound: false,
        resolution: '720p',
        fixedLens: false,
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
  const prompt = createWorkflowNode('text-input', { x: 120, y: 140 });
  const imageInput = createWorkflowNode('image-input', { x: 120, y: 360 });
  const imageGen = createWorkflowNode('image-generate', { x: 460, y: 120 });
  const videoGen = createWorkflowNode('video-generate', { x: 460, y: 320 });
  const motionGen = createWorkflowNode('motion-generate', { x: 840, y: 320 });
  const note = createWorkflowNode('note', { x: 120, y: 580 });

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
      createCanvasEdge(imageInput.id, 'image', videoGen.id, 'reference-image'),
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

export function normalizeWorkflowGraph(value: Partial<WorkflowCanvasGraph> | null | undefined): WorkflowCanvasGraph {
  const rawNodes = Array.isArray(value?.nodes) ? value.nodes : [];
  const rawEdges = Array.isArray(value?.edges) ? value.edges : [];

  const nodes = rawNodes.map((node) => normalizeNode(node)).filter(Boolean) as WorkflowCanvasNode[];
  return {
    version: typeof value?.version === 'number' ? value.version : WORKFLOW_GRAPH_VERSION,
    viewport: normalizeViewport(value?.viewport),
    nodes,
    edges: rawEdges.filter((edge): edge is WorkflowCanvasEdge => Boolean(edge?.id && edge.source && edge.target)),
  };
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
  const runState = createNodeRunState((data as Partial<BaseWorkflowNodeData> | undefined)?.runState);

  switch (type) {
    case 'text-input':
      return { ...(base as TextInputNodeData), text: typeof (data as TextInputNodeData | undefined)?.text === 'string' ? (data as TextInputNodeData).text : (base as TextInputNodeData).text, runState };
    case 'note':
      return { ...(base as NoteNodeData), text: typeof (data as NoteNodeData | undefined)?.text === 'string' ? (data as NoteNodeData).text : (base as NoteNodeData).text, runState };
    case 'image-input':
      return { ...(base as ImageInputNodeData), imageUrl: typeof (data as ImageInputNodeData | undefined)?.imageUrl === 'string' ? (data as ImageInputNodeData).imageUrl : null, storagePath: typeof (data as ImageInputNodeData | undefined)?.storagePath === 'string' ? (data as ImageInputNodeData).storagePath : null, runState };
    case 'video-input':
      return { ...(base as VideoInputNodeData), videoUrl: typeof (data as VideoInputNodeData | undefined)?.videoUrl === 'string' ? (data as VideoInputNodeData).videoUrl : null, storagePath: typeof (data as VideoInputNodeData | undefined)?.storagePath === 'string' ? (data as VideoInputNodeData).storagePath : null, runState };
    case 'audio-input':
      return { ...(base as AudioInputNodeData), audioUrl: typeof (data as AudioInputNodeData | undefined)?.audioUrl === 'string' ? (data as AudioInputNodeData).audioUrl : null, storagePath: typeof (data as AudioInputNodeData | undefined)?.storagePath === 'string' ? (data as AudioInputNodeData).storagePath : null, runState };
    case 'image-generate':
      return {
        ...(base as ImageGenerateNodeData),
        model: (data as ImageGenerateNodeData | undefined)?.model === 'nano-banana-pro' ? 'nano-banana-pro' : 'nano-banana-2',
        aspectRatio: typeof (data as ImageGenerateNodeData | undefined)?.aspectRatio === 'string' ? (data as ImageGenerateNodeData).aspectRatio : (base as ImageGenerateNodeData).aspectRatio,
        resolution: (data as ImageGenerateNodeData | undefined)?.resolution === '2K' || (data as ImageGenerateNodeData | undefined)?.resolution === '4K' ? (data as ImageGenerateNodeData).resolution : '1K',
        outputFormat: (data as ImageGenerateNodeData | undefined)?.outputFormat === 'png' ? 'png' : 'jpg',
        googleSearch: Boolean((data as ImageGenerateNodeData | undefined)?.googleSearch),
        runState,
      };
    case 'video-generate':
      return {
        ...(base as VideoGenerateNodeData),
        model: isVideoModel((data as VideoGenerateNodeData | undefined)?.model) ? (data as VideoGenerateNodeData).model : 'kling-3.0-video',
        aspectRatio: typeof (data as VideoGenerateNodeData | undefined)?.aspectRatio === 'string' ? (data as VideoGenerateNodeData).aspectRatio : (base as VideoGenerateNodeData).aspectRatio,
        duration: typeof (data as VideoGenerateNodeData | undefined)?.duration === 'number' ? (data as VideoGenerateNodeData).duration : (base as VideoGenerateNodeData).duration,
        mode: typeof (data as VideoGenerateNodeData | undefined)?.mode === 'string' ? (data as VideoGenerateNodeData).mode : (base as VideoGenerateNodeData).mode,
        sound: Boolean((data as VideoGenerateNodeData | undefined)?.sound),
        resolution: typeof (data as VideoGenerateNodeData | undefined)?.resolution === 'string' ? (data as VideoGenerateNodeData).resolution : (base as VideoGenerateNodeData).resolution,
        fixedLens: Boolean((data as VideoGenerateNodeData | undefined)?.fixedLens),
        runState,
      };
    case 'motion-generate':
      return {
        ...(base as MotionGenerateNodeData),
        model: (data as MotionGenerateNodeData | undefined)?.model === 'kling-2.6' ? 'kling-2.6' : 'kling-3.0',
        mode: (data as MotionGenerateNodeData | undefined)?.mode === '1080p' ? '1080p' : '720p',
        characterOrientation: (data as MotionGenerateNodeData | undefined)?.characterOrientation === 'image' ? 'image' : 'video',
        runState,
      };
    case 'voiceover-generate':
      return {
        ...(base as VoiceoverGenerateNodeData),
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
        model: 'music-v1',
        duration: typeof (data as MusicGenerateNodeData | undefined)?.duration === 'number' ? (data as MusicGenerateNodeData).duration : (base as MusicGenerateNodeData).duration,
        mood: typeof (data as MusicGenerateNodeData | undefined)?.mood === 'string' ? (data as MusicGenerateNodeData).mood : (base as MusicGenerateNodeData).mood,
        runState,
      };
    case 'sound-effects-generate':
      return {
        ...(base as SoundEffectsGenerateNodeData),
        model: normalizeSoundEffectModel((data as SoundEffectsGenerateNodeData | undefined)?.model),
        duration: typeof (data as SoundEffectsGenerateNodeData | undefined)?.duration === 'number' ? (data as SoundEffectsGenerateNodeData).duration : (base as SoundEffectsGenerateNodeData).duration,
        loop: Boolean((data as SoundEffectsGenerateNodeData | undefined)?.loop),
        promptInfluence: normalizeNumericValue((data as SoundEffectsGenerateNodeData | undefined)?.promptInfluence, (base as SoundEffectsGenerateNodeData).promptInfluence),
        outputFormat: (data as SoundEffectsGenerateNodeData | undefined)?.outputFormat === 'wav' ? 'wav' : 'mp3',
        runState,
      };
    case 'group':
      return { ...(base as GroupNodeData), color: typeof (data as GroupNodeData | undefined)?.color === 'string' ? (data as GroupNodeData).color : (base as GroupNodeData).color, runState };
  }
}

function isVideoModel(value: unknown): value is VideoGenerateNodeData['model'] {
  return value === 'kling-3.0-video' || value === 'seedance-1.5-pro' || value === 'veo-3.1';
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
  if (sourceType === 'image' && (targetType === 'reference-image' || targetType === 'image')) return true;
  if (sourceType === 'video' && targetType === 'reference-video') return true;
  return false;
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

export interface ResolvedWorkflowInputs extends Record<string, unknown> {
  prompt: string | null;
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
}

export function resolveNodeInputs(graph: WorkflowCanvasGraph, nodeId: string): ResolvedWorkflowInputs {
  const incoming = getIncomingEdges(graph, nodeId);
  const promptParts: string[] = [];
  const imageUrls: string[] = [];
  const videoUrls: string[] = [];
  const audioUrls: string[] = [];

  for (const edge of incoming) {
    const source = getNodeById(graph, edge.source);
    if (!source) continue;
    const sourceData = source.data;

    if (edge.sourceHandle === 'text' && 'text' in sourceData && typeof sourceData.text === 'string') {
      promptParts.push(sourceData.text.trim());
    }

    if (edge.sourceHandle === 'image') {
      const url = getNodeOutputUrl(source);
      if (url) imageUrls.push(url);
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
    imageUrls,
    videoUrls,
    audioUrls,
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

export function getExecutionOrder(graph: WorkflowCanvasGraph, startNodeId: string, mode: 'node' | 'branch'): string[] {
  if (mode === 'node') return [startNodeId];

  const reachable = new Set<string>();
  const queue = [startNodeId];

  while (queue.length > 0) {
    const current = queue.shift();
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
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    ordered.push(nodeId);

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
    if (!ordered.includes(nodeId)) {
      ordered.push(nodeId);
    }
  }

  return ordered;
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
