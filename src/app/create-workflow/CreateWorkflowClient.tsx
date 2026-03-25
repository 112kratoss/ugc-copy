'use client';

import '@xyflow/react/dist/style.css';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import Link from 'next/link';
import { ArrowLeft, Bot, Clapperboard, Copy, FileText, Image as ImageIcon, Layers3, Loader2, MessageSquareText, Mic, Music, PanelRightOpen, Play, Plus, Save, Trash2, Video, Volume2, Wand2, X, ZoomIn } from 'lucide-react';
import { getDisplayMediaUrl } from '@/lib/media-urls';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/app/components/AuthProvider';
import {
  buildImageLaunchUrl,
  buildMotionLaunchUrl,
  buildVideoLaunchUrl,
  createWorkflowGraphFromBlueprint,
  WORKFLOW_BLUEPRINT_COST,
  type WorkflowAspectRatio,
  type WorkflowBlueprint,
  type WorkflowObjective,
  type WorkflowPlannerInput,
} from '@/lib/workflow-blueprint';
import {
  type AudioInputNodeData,
  createWorkflowGraphHash,
  createStarterGraph,
  createWorkflowNode,
  DEFAULT_VIEWPORT,
  type DialogueTurn,
  duplicateWorkflowSelection,
  type ImageGenerateNodeData,
  type MusicGenerateNodeData,
  normalizeNodeData,
  validateWorkflowConnection,
  type ImageInputNodeData,
  type MotionGenerateNodeData,
  type NoteNodeData,
  type SoundEffectsGenerateNodeData,
  type TextInputNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type VoiceoverGenerateNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasEdge,
  type WorkflowCanvasNode,
  type WorkflowCanvasRecord,
  type WorkflowCanvasRunRecord,
  type WorkflowHandleType,
  type WorkflowNodeData,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import {
  drainQueuedCanvasSaves,
  flushCanvasSaveBeforeTransition,
  hasCanvasSaveChanges,
  type CanvasSaveRequest,
  type CanvasSaveResult,
} from './workflowCanvasSaveCoordinator';

type SaveState = 'saved' | 'dirty' | 'saving';
type PreviewMediaKind = 'image' | 'video' | 'audio';

interface CanvasSelectionState {
  nodeIds: string[];
  edgeIds: string[];
}

interface CanvasContextMenuState {
  x: number;
  y: number;
  target: 'pane' | 'node' | 'edge';
  flowPosition?: { x: number; y: number };
  nodeId?: string;
  edgeId?: string;
}

interface PreviewMediaState {
  kind: PreviewMediaKind;
  url: string;
  title: string;
}

interface CanvasFloatingPosition {
  left: number;
  top: number;
  width: number;
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}

function getCanvasFloatingPosition({
  canvasBounds,
  clientX,
  clientY,
  panelWidth,
  panelHeight,
}: {
  canvasBounds: DOMRect;
  clientX: number;
  clientY: number;
  panelWidth: number;
  panelHeight: number;
}): CanvasFloatingPosition {
  let left = clientX - canvasBounds.left + 18;
  let top = clientY - canvasBounds.top - 18;

  if (left + panelWidth > canvasBounds.width - 16) {
    left = Math.max(16, clientX - canvasBounds.left - panelWidth - 18);
  }

  if (top + panelHeight > canvasBounds.height - 16) {
    top = Math.max(16, canvasBounds.height - panelHeight - 16);
  }

  return {
    left: Math.max(16, left),
    top: Math.max(16, top),
    width: panelWidth,
  };
}

const NODE_LIBRARY: Array<{ type: WorkflowNodeKind; label: string; icon: ReactNode }> = [
  { type: 'text-input', label: 'Prompt', icon: <FileText className="h-4 w-4" /> },
  { type: 'image-input', label: 'Image input', icon: <ImageIcon className="h-4 w-4" /> },
  { type: 'video-input', label: 'Video input', icon: <Video className="h-4 w-4" /> },
  { type: 'audio-input', label: 'Audio input', icon: <Volume2 className="h-4 w-4" /> },
  { type: 'image-generate', label: 'Image gen', icon: <ImageIcon className="h-4 w-4" /> },
  { type: 'video-generate', label: 'Video gen', icon: <Clapperboard className="h-4 w-4" /> },
  { type: 'motion-generate', label: 'Motion', icon: <Wand2 className="h-4 w-4" /> },
  { type: 'voiceover-generate', label: 'Voiceover', icon: <Mic className="h-4 w-4" /> },
  { type: 'sound-effects-generate', label: 'Sound FX', icon: <Volume2 className="h-4 w-4" /> },
  { type: 'note', label: 'Note', icon: <MessageSquareText className="h-4 w-4" /> },
  { type: 'group', label: 'Group', icon: <Plus className="h-4 w-4" /> },
];

const VOICEOVER_MODEL_OPTIONS = [
  'text-to-speech-turbo-2-5',
  'text-to-speech-multilingual-v2',
  'text-to-dialogue-v3',
] as const;

const VOICEOVER_MODEL_LABELS: Record<(typeof VOICEOVER_MODEL_OPTIONS)[number], string> = {
  'text-to-speech-turbo-2-5': 'Turbo 2.5',
  'text-to-speech-multilingual-v2': 'Multilingual V2',
  'text-to-dialogue-v3': 'Dialogue V3',
};

const SOUND_EFFECT_MODEL_LABELS: Record<'sound-effect-v2', string> = {
  'sound-effect-v2': 'Sound Effect V2',
};

const HANDLE_COLORS: Record<string, string> = {
  text: '#f59e0b',
  prompt: '#f59e0b',
  image: '#38bdf8',
  'reference-image': '#38bdf8',
  video: '#22c55e',
  'reference-video': '#22c55e',
  audio: '#a78bfa',
  'reference-audio': '#a78bfa',
};

const DEFAULT_PLANNER_INPUT: WorkflowPlannerInput = {
  brandName: '',
  productName: '',
  audience: '',
  objective: 'ugc-ad',
  primaryMessage: '',
  offer: '',
  callToAction: 'Shop now',
  visualStyle: 'Creator-style UGC, natural light, product-forward framing',
  tone: 'Confident, direct, trustworthy',
  aspectRatio: '9:16',
  durationSeconds: 20,
  platform: 'TikTok and Instagram Reels',
  notes: '',
};

const WORKFLOW_OBJECTIVE_OPTIONS: Array<{ value: WorkflowObjective; label: string }> = [
  { value: 'ugc-ad', label: 'UGC ad' },
  { value: 'product-video', label: 'Product video' },
  { value: 'social-campaign', label: 'Social campaign' },
];

const WORKFLOW_OBJECTIVE_LABELS: Record<WorkflowObjective, string> = {
  'ugc-ad': 'UGC ad',
  'product-video': 'Product video',
  'social-campaign': 'Social campaign',
};

const WORKFLOW_ASPECT_RATIO_OPTIONS: Array<{ value: WorkflowAspectRatio; label: string }> = [
  { value: '9:16', label: '9:16 vertical' },
  { value: '16:9', label: '16:9 widescreen' },
  { value: '1:1', label: '1:1 square' },
];

const PreviewMediaContext = createContext<(preview: PreviewMediaState) => void>(() => undefined);

function getEdgeStrokeColor(edge: Pick<WorkflowCanvasEdge, 'sourceHandle'>): string {
  return HANDLE_COLORS[edge.sourceHandle || ''] || '#d4d4d8';
}

function decorateWorkflowEdge(edge: WorkflowCanvasEdge): WorkflowCanvasEdge {
  return {
    ...edge,
    animated: edge.animated ?? true,
    interactionWidth: edge.interactionWidth ?? 32,
    style: {
      stroke: getEdgeStrokeColor(edge),
      strokeWidth: 2,
      ...(edge.style || {}),
    },
  };
}

function SourceHandle({ id, top }: { id: string; top: number }) {
  return <Handle type="source" position={Position.Right} id={id} style={{ top, right: -6, width: 12, height: 12, background: HANDLE_COLORS[id] || '#fff', border: '2px solid #09090b' }} />;
}

function TargetHandle({ id, top }: { id: string; top: number }) {
  return <Handle type="target" position={Position.Left} id={id} style={{ top, left: -6, width: 12, height: 12, background: HANDLE_COLORS[id] || '#fff', border: '2px solid #09090b' }} />;
}

function NodeShell({
  icon,
  title,
  subtitle,
  status,
  preview,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  status: string;
  preview?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-[230px] max-w-[260px] rounded-2xl border border-white/10 bg-zinc-950/95 p-3 shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-white">
          <span className="rounded-xl border border-white/10 bg-white/5 p-2 text-zinc-200">{icon}</span>
          <div>
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-[11px] text-zinc-500">{subtitle}</div>
          </div>
        </div>
        <span className={`rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${
          status === 'succeeded'
            ? 'bg-emerald-500/10 text-emerald-300'
            : status === 'queued'
              ? 'bg-sky-500/10 text-sky-300'
            : status === 'processing'
              ? 'bg-amber-500/10 text-amber-300'
            : status === 'failed' || status === 'blocked'
                ? 'bg-rose-500/10 text-rose-300'
                : 'bg-white/5 text-zinc-400'
        }`}>
          {status}
        </span>
      </div>
      {preview}
      {children}
    </div>
  );
}

function PreviewMediaLink({
  href,
  label,
  kind,
  children,
}: {
  href: string;
  label: string;
  kind: PreviewMediaKind;
  children: ReactNode;
}) {
  const openPreview = useContext(PreviewMediaContext);

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        openPreview({ kind, url: href, title: label });
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className="group relative mt-3 block w-full overflow-hidden rounded-xl bg-transparent text-left"
      title={label}
      aria-label={label}
      onKeyDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {children}
      <span className="pointer-events-none absolute inset-x-2 bottom-2 rounded-full bg-black/70 px-2 py-1 text-center text-[10px] font-medium uppercase tracking-[0.16em] text-white opacity-0 transition group-hover:opacity-100">
        Open preview
      </span>
    </button>
  );
}

function TextInputNode({ data }: NodeProps) {
  const typed = data as unknown as TextInputNodeData;
  return (
    <NodeShell icon={<FileText className="h-4 w-4" />} title={typed.title} subtitle={typed.subtitle} status={typed.runState.status}>
      <TargetHandle id="prompt" top={36} />
      <SourceHandle id="text" top={78} />
      <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-zinc-200">
        {typed.text}
      </div>
    </NodeShell>
  );
}

function NoteNode({ data }: NodeProps) {
  const typed = data as unknown as NoteNodeData;
  return (
    <NodeShell icon={<MessageSquareText className="h-4 w-4" />} title={typed.title} subtitle={typed.subtitle} status={typed.runState.status}>
      <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-zinc-300">
        {typed.text}
      </div>
    </NodeShell>
  );
}

function ImageInputNode({ data }: NodeProps) {
  const typed = data as unknown as ImageInputNodeData;
  const previewUrl = typed.storagePath ? getDisplayMediaUrl(typed.storagePath) : typed.imageUrl ? getDisplayMediaUrl(typed.imageUrl) : null;
  return (
    <NodeShell
      icon={<ImageIcon className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open image input preview" kind="image">
          <img src={previewUrl} alt="" className="h-28 w-full rounded-xl border border-white/10 object-cover transition group-hover:scale-[1.02]" />
        </PreviewMediaLink>
      ) : undefined}
    >
      <SourceHandle id="image" top={92} />
      {!typed.imageUrl && <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">Upload an image or connect one here.</div>}
    </NodeShell>
  );
}

function VideoInputNode({ data }: NodeProps) {
  const typed = data as unknown as VideoInputNodeData;
  const previewUrl = typed.storagePath ? getDisplayMediaUrl(typed.storagePath) : typed.videoUrl ? getDisplayMediaUrl(typed.videoUrl) : null;
  return (
    <NodeShell
      icon={<Video className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open video input preview" kind="video">
          <video src={previewUrl} className="h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline />
        </PreviewMediaLink>
      ) : undefined}
    >
      <SourceHandle id="video" top={92} />
      {!typed.videoUrl && <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">Upload a reference video or connect one here.</div>}
    </NodeShell>
  );
}

function AudioInputNode({ data }: NodeProps) {
  const typed = data as unknown as AudioInputNodeData;
  const previewUrl = typed.storagePath ? getDisplayMediaUrl(typed.storagePath) : typed.audioUrl ? getDisplayMediaUrl(typed.audioUrl) : null;
  return (
    <NodeShell
      icon={<Volume2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      preview={previewUrl ? <audio src={previewUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
    >
      <SourceHandle id="audio" top={92} />
      {!typed.audioUrl && <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">Upload a track or connect future audio outputs here.</div>}
    </NodeShell>
  );
}

function ImageGenerateNode({ data }: NodeProps) {
  const typed = data as unknown as ImageGenerateNodeData;
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  return (
    <NodeShell
      icon={<ImageIcon className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open generated image" kind="image">
          <img src={previewUrl} alt="" className="h-28 w-full rounded-xl border border-white/10 object-cover transition group-hover:scale-[1.02]" />
        </PreviewMediaLink>
      ) : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <TargetHandle id="reference-image" top={78} />
      <SourceHandle id="image" top={118} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>Aspect {typed.aspectRatio}</div>
        <div>{typed.resolution} • {typed.outputFormat}</div>
      </div>
    </NodeShell>
  );
}

function VideoGenerateNode({ data }: NodeProps) {
  const typed = data as unknown as VideoGenerateNodeData;
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  return (
    <NodeShell
      icon={<Clapperboard className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open generated video" kind="video">
          <video src={previewUrl} className="h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline />
        </PreviewMediaLink>
      ) : undefined}
    >
      <TargetHandle id="prompt" top={34} />
      <TargetHandle id="reference-image" top={70} />
      <SourceHandle id="video" top={118} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{typed.aspectRatio} • {typed.duration}s</div>
        <div>{typed.model === 'seedance-1.5-pro' ? typed.resolution : typed.mode} • {typed.sound ? 'native audio on' : 'silent'}</div>
      </div>
    </NodeShell>
  );
}

function MotionGenerateNode({ data }: NodeProps) {
  const typed = data as unknown as MotionGenerateNodeData;
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  return (
    <NodeShell
      icon={<Wand2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open motion output" kind="video">
          <video src={previewUrl} className="h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline />
        </PreviewMediaLink>
      ) : undefined}
    >
      <TargetHandle id="reference-image" top={34} />
      <TargetHandle id="reference-video" top={72} />
      <TargetHandle id="prompt" top={110} />
      <SourceHandle id="video" top={146} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{typed.mode} • {typed.characterOrientation}</div>
      </div>
    </NodeShell>
  );
}

function VoiceoverGenerateNode({ data }: NodeProps) {
  const typed = data as unknown as VoiceoverGenerateNodeData;
  const isDialogueModel = typed.model === 'text-to-dialogue-v3';
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  return (
    <NodeShell
      icon={<Mic className="h-4 w-4" />}
      title={typed.title}
      subtitle={VOICEOVER_MODEL_LABELS[typed.model] || typed.model}
      status={typed.runState.status}
      preview={previewUrl ? <audio src={previewUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <SourceHandle id="audio" top={86} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{isDialogueModel ? `${typed.dialogueTurns.length} dialogue turn${typed.dialogueTurns.length === 1 ? '' : 's'}` : typed.voice}</div>
        <div>Language {typed.languageCode}</div>
      </div>
    </NodeShell>
  );
}

function MusicGenerateNode({ data }: NodeProps) {
  const typed = data as unknown as MusicGenerateNodeData;
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  return (
    <NodeShell
      icon={<Music className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={previewUrl ? <audio src={previewUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <SourceHandle id="audio" top={86} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{typed.duration}s</div>
        <div>{typed.mood}</div>
      </div>
    </NodeShell>
  );
}

function SoundEffectsGenerateNode({ data }: NodeProps) {
  const typed = data as unknown as SoundEffectsGenerateNodeData;
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  return (
    <NodeShell
      icon={<Volume2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={SOUND_EFFECT_MODEL_LABELS[typed.model] || typed.model}
      status={typed.runState.status}
      preview={previewUrl ? <audio src={previewUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <SourceHandle id="audio" top={86} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{typed.duration}s • {typed.outputFormat.toUpperCase()}</div>
        <div>{typed.loop ? 'Loop enabled' : 'One-shot'} • Influence {typed.promptInfluence}</div>
      </div>
    </NodeShell>
  );
}

function GroupNode({ data }: NodeProps) {
  const typed = data as unknown as WorkflowNodeData;
  return (
    <div className="min-w-[250px] rounded-[28px] border border-dashed border-amber-400/25 bg-amber-500/[0.04] px-5 py-4 text-sm text-amber-100 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
      {typed.title}
    </div>
  );
}

const nodeTypes = {
  'text-input': TextInputNode,
  'image-input': ImageInputNode,
  'video-input': VideoInputNode,
  'audio-input': AudioInputNode,
  'image-generate': ImageGenerateNode,
  'video-generate': VideoGenerateNode,
  'motion-generate': MotionGenerateNode,
  'voiceover-generate': VoiceoverGenerateNode,
  'music-generate': MusicGenerateNode,
  'sound-effects-generate': SoundEffectsGenerateNode,
  note: NoteNode,
  group: GroupNode,
};

export default function CreateWorkflowPage() {
  const { session } = useAuth();
  const canvasSectionRef = useRef<HTMLElement | null>(null);
  const [canvases, setCanvases] = useState<WorkflowCanvasRecord[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [canvasTitle, setCanvasTitle] = useState('Workflow canvas');
  const [activeCanvasRevision, setActiveCanvasRevision] = useState(0);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [isPlannerOpen, setIsPlannerOpen] = useState(false);
  const [plannerInput, setPlannerInput] = useState<WorkflowPlannerInput>(DEFAULT_PLANNER_INPUT);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [generatedBlueprint, setGeneratedBlueprint] = useState<WorkflowBlueprint | null>(null);
  const [generatedBlueprintInput, setGeneratedBlueprintInput] = useState<WorkflowPlannerInput | null>(null);
  const [remainingPlannerCredits, setRemainingPlannerCredits] = useState<number | null>(null);
  const [isGeneratingBlueprint, setIsGeneratingBlueprint] = useState(false);
  const [isApplyingBlueprint, setIsApplyingBlueprint] = useState(false);
  const [isCanvasTransitionPending, setIsCanvasTransitionPending] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<PreviewMediaState | null>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenuState | null>(null);
  const [edgeFloatingPosition, setEdgeFloatingPosition] = useState<CanvasFloatingPosition | null>(null);
  const starter = useMemo(() => createStarterGraph(), []);
  const autosaveTimer = useRef<NodeJS.Timeout | null>(null);
  const activeCanvasIdRef = useRef<string | null>(null);
  const activeCanvasRevisionRef = useRef(0);
  const canvasTitleRef = useRef('Workflow canvas');
  const graphRef = useRef<WorkflowCanvasGraph>(starter);
  const lastPersistedTitleRef = useRef('Workflow canvas');
  const lastPersistedGraphHashRef = useRef<string>(createWorkflowGraphHash(starter));
  const saveInFlightRef = useRef(false);
  const savePromiseRef = useRef<Promise<CanvasSaveResult> | null>(null);
  const pendingSaveRef = useRef<CanvasSaveRequest | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(starter.edges.map(decorateWorkflowEdge));

  const graph = useMemo<WorkflowCanvasGraph>(() => ({
    version: starter.version,
    nodes: nodes.map((node) => ({ ...node, data: normalizeNodeData(node.type as WorkflowNodeKind, node.data) })),
    edges: edges.map((edge) => decorateWorkflowEdge(edge)),
    viewport,
  }), [nodes, edges, starter.version, viewport]);
  const graphHash = useMemo(() => createWorkflowGraphHash(graph), [graph]);

  useEffect(() => {
    activeCanvasIdRef.current = activeCanvasId;
  }, [activeCanvasId]);

  useEffect(() => {
    activeCanvasRevisionRef.current = activeCanvasRevision;
  }, [activeCanvasRevision]);

  useEffect(() => {
    canvasTitleRef.current = canvasTitle;
  }, [canvasTitle]);

  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  const selectedNode = useMemo(() => {
    if (selectedNodeIds.length !== 1 || selectedEdgeIds.length > 0) {
      return null;
    }

    return nodes.find((node) => node.id === selectedNodeIds[0]) || null;
  }, [nodes, selectedEdgeIds.length, selectedNodeIds]);
  const selectedEdge = useMemo(() => {
    if (selectedEdgeIds.length !== 1 || selectedNodeIds.length > 0) {
      return null;
    }

    return edges.find((edge) => edge.id === selectedEdgeIds[0]) || null;
  }, [edges, selectedEdgeIds, selectedNodeIds.length]);
  const selection = useMemo<CanvasSelectionState>(() => ({
    nodeIds: selectedNodeIds,
    edgeIds: selectedEdgeIds,
  }), [selectedEdgeIds, selectedNodeIds]);
  const openPreviewMedia = useCallback((preview: PreviewMediaState) => {
    setPreviewMedia(preview);
  }, []);

  const setManualSelection = useCallback((nextSelection: CanvasSelectionState) => {
    const nodeIdSet = new Set(nextSelection.nodeIds);
    const edgeIdSet = new Set(nextSelection.edgeIds);

    setNodes((current) =>
      current.some((node) => node.selected !== nodeIdSet.has(node.id))
        ? current.map((node) =>
            node.selected === nodeIdSet.has(node.id)
              ? node
              : { ...node, selected: nodeIdSet.has(node.id) }
          )
        : current
    );
    setEdges((current) =>
      current.some((edge) => edge.selected !== edgeIdSet.has(edge.id))
        ? current.map((edge) => {
            const nextSelected = edgeIdSet.has(edge.id);
            return edge.selected === nextSelected
              ? edge
              : decorateWorkflowEdge({ ...edge, selected: nextSelected });
          })
        : current
    );
    setSelectedNodeIds((current) => areStringArraysEqual(current, nextSelection.nodeIds) ? current : nextSelection.nodeIds);
    setSelectedEdgeIds((current) => areStringArraysEqual(current, nextSelection.edgeIds) ? current : nextSelection.edgeIds);
  }, [setEdges, setNodes]);

  const clearSelection = useCallback(() => {
    setEdgeFloatingPosition(null);
    setManualSelection({ nodeIds: [], edgeIds: [] });
  }, [setManualSelection]);

  const syncCanvasState = useCallback((canvas: WorkflowCanvasRecord) => {
    activeCanvasIdRef.current = canvas.id;
    activeCanvasRevisionRef.current = canvas.revision ?? 0;
    canvasTitleRef.current = canvas.title;
    graphRef.current = canvas.graph;
    setActiveCanvasId(canvas.id);
    setCanvasTitle(canvas.title);
    setActiveCanvasRevision(canvas.revision ?? 0);
    setNodes(canvas.graph.nodes.map((node) => ({ ...node, selected: false })));
    setEdges(canvas.graph.edges.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })));
    setViewport(canvas.graph.viewport || DEFAULT_VIEWPORT);
    lastPersistedTitleRef.current = canvas.title;
    lastPersistedGraphHashRef.current = createWorkflowGraphHash(canvas.graph);
    pendingSaveRef.current = null;
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setActiveRunId(null);
    setSaveState('saved');
    setError(null);
    setContextMenu(null);
    setEdgeFloatingPosition(null);
  }, [setEdges, setNodes]);

  const authHeaders = useCallback(async () => {
    const token = session?.access_token;
    if (!token) throw new Error('Please log in to use the workflow canvas.');
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }, [session?.access_token]);

  const loadCanvases = useCallback(async () => {
    try {
      if (!session) {
        return;
      }

      const response = await fetch('/api/workflow-canvases', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load workflow canvases');

      const nextCanvases = data.canvases as WorkflowCanvasRecord[];
      setCanvases(nextCanvases);

      if (nextCanvases.length === 0) {
        const createResponse = await fetch('/api/workflow-canvases', {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify({
            title: 'UGC workflow canvas',
            graph: createStarterGraph(),
          }),
        });
        const created = await createResponse.json();
        if (!createResponse.ok) throw new Error(created.error || 'Failed to create starter canvas');
        const canvas = created.canvas as WorkflowCanvasRecord;
        setCanvases([canvas]);
        syncCanvasState(canvas);
      } else {
        syncCanvasState(nextCanvases[0]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load canvas');
    } finally {
      setIsLoading(false);
    }
  }, [authHeaders, session, syncCanvasState]);

  useEffect(() => {
    if (!session) {
      return;
    }

    loadCanvases();
  }, [loadCanvases, session]);

  useEffect(() => {
    if (!reactFlowInstance) return;
    void reactFlowInstance.setViewport(viewport, { duration: 0 });
  }, [reactFlowInstance, viewport]);

  useEffect(() => {
    const canvasSection = canvasSectionRef.current;
    if (!canvasSection || !reactFlowInstance) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;

      const nextViewport = {
        ...viewport,
        x: viewport.x - (horizontalDelta / Math.max(viewport.zoom, 0.1)) * 0.65,
      };

      setViewport(nextViewport);
      void reactFlowInstance.setViewport(nextViewport, { duration: 0 });
    };

    canvasSection.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => canvasSection.removeEventListener('wheel', onWheel, true);
  }, [reactFlowInstance, viewport]);

  useEffect(() => {
    if (!previewMedia) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewMedia(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewMedia]);

  const buildSaveRequest = useCallback((overrides?: Partial<Pick<CanvasSaveRequest, 'title' | 'graph'>>) => {
    const canvasId = activeCanvasIdRef.current;
    if (!canvasId) {
      return null;
    }

    return {
      canvasId,
      baseRevision: activeCanvasRevisionRef.current,
      title: overrides?.title ?? canvasTitleRef.current,
      graph: overrides?.graph ?? graphRef.current,
    } satisfies CanvasSaveRequest;
  }, []);

  const executeSaveRequest = useCallback(async (request: CanvasSaveRequest): Promise<CanvasSaveResult> => {
    const nextGraphHash = createWorkflowGraphHash(request.graph);

    if (
      request.canvasId === activeCanvasIdRef.current &&
      request.title === lastPersistedTitleRef.current &&
      nextGraphHash === lastPersistedGraphHashRef.current
    ) {
      setSaveState(saveInFlightRef.current ? 'saving' : 'saved');
      return {
        status: 'noop',
        canvasId: request.canvasId,
        revision: activeCanvasRevisionRef.current,
      };
    }

    try {
      const response = await fetch(`/api/workflow-canvases/${request.canvasId}`, {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({
          title: request.title,
          graph: request.graph,
          baseRevision: request.baseRevision,
          graphHash: nextGraphHash,
        }),
      });
      const data = await response.json();

      if (response.status === 409 && data.canvas) {
        const conflictedCanvas = data.canvas as WorkflowCanvasRecord;
        setCanvases((current) =>
          current.map((canvas) => canvas.id === request.canvasId ? conflictedCanvas : canvas)
        );
        if (activeCanvasIdRef.current === request.canvasId) {
          syncCanvasState(conflictedCanvas);
        }
        setError('A newer canvas revision was detected. The latest saved version has been reloaded.');
        return {
          status: 'conflict',
          canvas: conflictedCanvas,
        };
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save canvas');
      }

      const savedCanvas = data.canvas as WorkflowCanvasRecord;
      setCanvases((current) =>
        current.map((canvas) => canvas.id === request.canvasId ? savedCanvas : canvas)
      );

      if (activeCanvasIdRef.current === request.canvasId) {
        activeCanvasRevisionRef.current = savedCanvas.revision ?? request.baseRevision;
        lastPersistedTitleRef.current = savedCanvas.title;
        lastPersistedGraphHashRef.current = createWorkflowGraphHash(savedCanvas.graph);
        setActiveCanvasRevision(savedCanvas.revision ?? request.baseRevision);
        setSaveState('saved');
        setError(null);
      }

      return {
        status: 'saved',
        canvas: savedCanvas,
        revision: savedCanvas.revision ?? request.baseRevision,
      };
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save canvas';
      if (activeCanvasIdRef.current === request.canvasId) {
        setSaveState('dirty');
      }
      setError(message);
      return {
        status: 'failed',
        canvasId: request.canvasId,
        error: message,
      };
    }
  }, [authHeaders, syncCanvasState]);

  const drainSaveQueue = useCallback(async (initialRequest: CanvasSaveRequest): Promise<CanvasSaveResult> => {
    return drainQueuedCanvasSaves({
      initialRequest,
      executeSaveRequest,
      takePendingSave: () => {
        const pendingSave = pendingSaveRef.current;
        pendingSaveRef.current = null;
        return pendingSave;
      },
      clearPendingSave: () => {
        pendingSaveRef.current = null;
      },
    });
  }, [executeSaveRequest]);

  const persistCanvas = useCallback((nextTitle?: string, nextGraph?: WorkflowCanvasGraph) => {
    const request = buildSaveRequest({
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      ...(nextGraph !== undefined ? { graph: nextGraph } : {}),
    });

    if (!request) {
      return Promise.resolve<CanvasSaveResult>({
        status: 'failed',
        canvasId: '',
        error: 'No active canvas to save.',
      });
    }

    const nextGraphHash = createWorkflowGraphHash(request.graph);
    if (
      request.title === lastPersistedTitleRef.current &&
      nextGraphHash === lastPersistedGraphHashRef.current
    ) {
      setSaveState(saveInFlightRef.current ? 'saving' : 'saved');
      return savePromiseRef.current ?? Promise.resolve<CanvasSaveResult>({
        status: 'noop',
        canvasId: request.canvasId,
        revision: activeCanvasRevisionRef.current,
      });
    }

    if (savePromiseRef.current) {
      pendingSaveRef.current = request;
      setSaveState('saving');
      return savePromiseRef.current;
    }

    saveInFlightRef.current = true;
    setSaveState('saving');
    const savePromise = drainSaveQueue(request).finally(() => {
      saveInFlightRef.current = false;
      savePromiseRef.current = null;
    });
    savePromiseRef.current = savePromise;
    return savePromise;
  }, [buildSaveRequest, drainSaveQueue]);

  const flushActiveCanvasBeforeTransition = useCallback(async () => {
    const request = buildSaveRequest();

    setIsCanvasTransitionPending(true);
    try {
      return await flushCanvasSaveBeforeTransition({
        request,
        lastPersistedTitle: lastPersistedTitleRef.current,
        lastPersistedGraphHash: lastPersistedGraphHashRef.current,
        currentSavePromise: savePromiseRef.current,
        clearAutosaveTimer: () => {
          if (autosaveTimer.current) {
            clearTimeout(autosaveTimer.current);
            autosaveTimer.current = null;
          }
        },
        persistRequest: (pendingRequest) => persistCanvas(pendingRequest.title, pendingRequest.graph),
      });
    } finally {
      setIsCanvasTransitionPending(false);
    }
  }, [buildSaveRequest, persistCanvas]);

  useEffect(() => {
    if (!activeCanvasId || isLoading) return;
    const hasUnsavedChanges = hasCanvasSaveChanges({
      canvasId: activeCanvasId,
      baseRevision: activeCanvasRevisionRef.current,
      title: canvasTitle,
      graph,
    }, lastPersistedTitleRef.current, lastPersistedGraphHashRef.current);

    if (!hasUnsavedChanges) {
      setSaveState(saveInFlightRef.current ? 'saving' : 'saved');
      return;
    }

    setSaveState('dirty');
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void persistCanvas();
    }, 900);
    return () => {
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [activeCanvasId, canvasTitle, graph, graphHash, isLoading, persistCanvas]);

  const syncRunIntoNodes = useCallback((run: WorkflowCanvasRunRecord) => {
    const stepMap = new Map((run.steps || []).map((step) => [step.node_id, step]));
    setNodes((current) =>
      current.map((node) => {
        const step = stepMap.get(node.id);
        if (!step) return node;
        const outputUrl = (step.output_snapshot as { outputUrl?: string } | null)?.outputUrl || node.data.runState.outputUrl;
        return {
          ...node,
          data: normalizeNodeData(node.type as WorkflowNodeKind, {
            ...node.data,
            runState: {
              ...node.data.runState,
              status: step.status as WorkflowNodeData['runState']['status'],
              generationId: step.generation_id,
              outputUrl,
              error: step.error_message,
              updatedAt: step.finished_at || step.started_at,
            },
          }),
        };
      })
    );
  }, [setNodes]);

  useEffect(() => {
    if (!activeCanvasId || !activeRunId) return;
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/runs/${activeRunId}`, {
          headers: await authHeaders(),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to refresh workflow run');
        const run = data.run as WorkflowCanvasRunRecord;
        syncRunIntoNodes(run);
        if (run.status !== 'processing') {
          setActiveRunId(null);
        }
      } catch (pollError) {
        console.error(pollError);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [activeCanvasId, activeRunId, authHeaders, syncRunIntoNodes]);

  const updateNode = useCallback((nodeId: string, updates: Partial<WorkflowNodeData>) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: normalizeNodeData(node.type as WorkflowNodeKind, {
                ...node.data,
                ...updates,
              }),
            }
          : node
      )
    );
  }, [setNodes]);

  const handleConnect = useCallback((connection: Connection) => {
    if (!validateWorkflowConnection(connection.sourceHandle as WorkflowHandleType | null, connection.targetHandle as WorkflowHandleType | null)) {
      setError('That connection is not supported. Try matching prompt, image, or video handles.');
      return;
    }

    setEdges((current) =>
      addEdge(
        decorateWorkflowEdge({
          ...connection,
        } as WorkflowCanvasEdge),
        current
      )
    );
    setContextMenu(null);
  }, [setEdges]);

  const addNode = useCallback((type: WorkflowNodeKind, position?: { x: number; y: number }) => {
    const canvasBounds = canvasSectionRef.current?.getBoundingClientRect();
    const nextPosition = position ?? (
      reactFlowInstance && canvasBounds
        ? reactFlowInstance.screenToFlowPosition({
            x: canvasBounds.left + Math.min(canvasBounds.width * 0.45, 520),
            y: canvasBounds.top + Math.min(canvasBounds.height * 0.4, 360),
          })
        : { x: 300, y: 220 }
    );
    const nextNode = createWorkflowNode(type, nextPosition);
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      { ...nextNode, selected: true },
    ]);
    setEdges((current) => current.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })));
    setSelectedNodeIds([nextNode.id]);
    setSelectedEdgeIds([]);
    setContextMenu(null);
    setEdgeFloatingPosition(null);
    return nextNode;
  }, [reactFlowInstance, setEdges, setNodes]);

  const deleteSelection = useCallback((targetSelection?: CanvasSelectionState) => {
    const nextSelection = targetSelection ?? selection;
    if (nextSelection.nodeIds.length === 0 && nextSelection.edgeIds.length === 0) {
      return;
    }

    const nodeIdSet = new Set(nextSelection.nodeIds);
    const edgeIdSet = new Set(nextSelection.edgeIds);
    setNodes((current) => current.filter((node) => !nodeIdSet.has(node.id)));
    setEdges((current) =>
      current.filter(
        (edge) =>
          !edgeIdSet.has(edge.id) &&
          !nodeIdSet.has(edge.source) &&
          !nodeIdSet.has(edge.target)
      )
    );
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setContextMenu(null);
    setEdgeFloatingPosition(null);
  }, [selection, setEdges, setNodes]);

  const duplicateSelection = useCallback((targetSelection?: CanvasSelectionState) => {
    const nextSelection = targetSelection ?? selection;
    if (nextSelection.nodeIds.length === 0) {
      return;
    }

    const result = duplicateWorkflowSelection({ nodes, edges }, nextSelection.nodeIds);
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...result.duplicatedNodes.map((node) => ({ ...node, selected: true })),
    ]);
    setEdges((current) => [
      ...current.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })),
      ...result.duplicatedEdges.map((edge) => decorateWorkflowEdge({ ...edge, selected: true })),
    ]);
    setSelectedNodeIds(result.duplicatedNodes.map((node) => node.id));
    setSelectedEdgeIds(result.duplicatedEdges.map((edge) => edge.id));
    setContextMenu(null);
    setEdgeFloatingPosition(null);
  }, [edges, nodes, selection, setEdges, setNodes]);

  const selectAllElements = useCallback(() => {
    setManualSelection({
      nodeIds: nodes.map((node) => node.id),
      edgeIds: edges.map((edge) => edge.id),
    });
    setContextMenu(null);
  }, [edges, nodes, setManualSelection]);

  const createCanvas = useCallback(async (options?: { title?: string; graph?: WorkflowCanvasGraph }) => {
    try {
      const canTransition = await flushActiveCanvasBeforeTransition();
      if (!canTransition) {
        return null;
      }

      const response = await fetch('/api/workflow-canvases', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          title: options?.title ?? `Workflow ${canvases.length + 1}`,
          graph: options?.graph ?? createStarterGraph(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to create canvas');
      setCanvases((current) => [data.canvas, ...current]);
      syncCanvasState(data.canvas);
      return data.canvas as WorkflowCanvasRecord;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create canvas');
      return null;
    }
  }, [authHeaders, canvases.length, flushActiveCanvasBeforeTransition, syncCanvasState]);

  const updatePlannerInput = useCallback((
    field: keyof WorkflowPlannerInput,
    value: WorkflowPlannerInput[keyof WorkflowPlannerInput]
  ) => {
    setPlannerInput((current) => ({ ...current, [field]: value }));
  }, []);

  const generateBlueprint = useCallback(async () => {
    setPlannerError(null);
    setError(null);
    setIsGeneratingBlueprint(true);

    try {
      const response = await fetch('/api/workflow-blueprint', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(plannerInput),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate workflow blueprint');
      }

      const snapshot = { ...plannerInput };
      setGeneratedBlueprint(data.blueprint as WorkflowBlueprint);
      setGeneratedBlueprintInput(snapshot);
      setRemainingPlannerCredits(typeof data.remainingCredits === 'number' ? data.remainingCredits : null);
    } catch (generationError) {
      setPlannerError(generationError instanceof Error ? generationError.message : 'Failed to generate workflow blueprint');
    } finally {
      setIsGeneratingBlueprint(false);
    }
  }, [authHeaders, plannerInput]);

  const applyBlueprintToCanvas = useCallback(async () => {
    if (!generatedBlueprint || !generatedBlueprintInput) {
      return;
    }

    setPlannerError(null);
    setIsApplyingBlueprint(true);

    const createdCanvas = await createCanvas({
      title: generatedBlueprint.title,
      graph: createWorkflowGraphFromBlueprint(generatedBlueprint, generatedBlueprintInput.aspectRatio),
    });

    if (createdCanvas) {
      setIsPlannerOpen(false);
    } else {
      setPlannerError('Failed to create canvas from blueprint.');
    }

    setIsApplyingBlueprint(false);
  }, [createCanvas, generatedBlueprint, generatedBlueprintInput]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditableTarget = Boolean(
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      );

      if (event.key === 'Escape') {
        event.preventDefault();
        if (previewMedia) {
          setPreviewMedia(null);
          return;
        }
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        if (isPlannerOpen) {
          setIsPlannerOpen(false);
          return;
        }
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          clearSelection();
        }
        return;
      }

      if (isEditableTarget) {
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          event.preventDefault();
          deleteSelection();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        if (selection.nodeIds.length > 0) {
          event.preventDefault();
          duplicateSelection();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllElements();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, contextMenu, deleteSelection, duplicateSelection, isPlannerOpen, previewMedia, selectAllElements, selection]);

  const deleteCanvas = useCallback(async (canvasId: string) => {
    try {
      if (canvasId === activeCanvasIdRef.current) {
        const canTransition = await flushActiveCanvasBeforeTransition();
        if (!canTransition) {
          return;
        }
      }

      const response = await fetch(`/api/workflow-canvases/${canvasId}`, {
        method: 'DELETE',
        headers: await authHeaders(),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to delete canvas');
      const remaining = canvases.filter((canvas) => canvas.id !== canvasId);
      setCanvases(remaining);
      if (remaining[0]) {
        syncCanvasState(remaining[0]);
      } else {
        void createCanvas();
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete canvas');
    }
  }, [authHeaders, canvases, createCanvas, flushActiveCanvasBeforeTransition, syncCanvasState]);

  const selectCanvas = useCallback(async (canvas: WorkflowCanvasRecord) => {
    if (canvas.id === activeCanvasIdRef.current) {
      return;
    }

    const canTransition = await flushActiveCanvasBeforeTransition();
    if (!canTransition) {
      return;
    }

    syncCanvasState(canvas);
  }, [flushActiveCanvasBeforeTransition, syncCanvasState]);

  const runCanvas = useCallback(async (mode: 'node' | 'branch', startNodeId?: string) => {
    const nodeId = startNodeId ?? selectedNodeIds[0];
    if (!activeCanvasId || !nodeId) {
      setError('Select a node to run this workflow.');
      return;
    }

    try {
      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/run`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          startNodeId: nodeId,
          mode,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to run workflow');
      setActiveRunId(data.runId as string);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Failed to run workflow');
    }
  }, [activeCanvasId, authHeaders, selectedNodeIds]);

  const uploadAssetToBucket = useCallback(async (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => {
    const user = session?.user ?? null;
    if (!user) throw new Error('Please log in to upload media.');
    const extension = file.name.split('.').pop() || (bucket === 'generated_images' ? 'jpg' : bucket === 'generated_audio' ? 'mp3' : 'mp4');
    const filePath = `${user.id}/workflow-input-${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from(bucket).upload(filePath, file, { upsert: true });
    if (uploadError) throw new Error(uploadError.message);
    const { data: signed, error: signedError } = await supabase.storage.from(bucket).createSignedUrl(filePath, 3600);
    if (signedError || !signed?.signedUrl) throw new Error(signedError?.message || 'Failed to sign upload');
    return {
      signedUrl: signed.signedUrl,
      storagePath: `${bucket}/${filePath}`,
    };
  }, [session]);

  const handlePaneClick = useCallback(() => {
    clearSelection();
    setContextMenu(null);
  }, [clearSelection]);

  const handlePaneContextMenu = useCallback((event: MouseEvent | ReactMouseEvent) => {
    event.preventDefault();
    const flowPosition = reactFlowInstance?.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'pane',
      flowPosition: flowPosition ?? undefined,
    });
  }, [reactFlowInstance]);

  const handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: WorkflowCanvasNode) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selection.nodeIds.includes(node.id)) {
      setManualSelection({ nodeIds: [node.id], edgeIds: [] });
    }
    setEdgeFloatingPosition(null);

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'node',
      nodeId: node.id,
    });
  }, [selection.nodeIds, setManualSelection]);

  const handleEdgeClick = useCallback((event: ReactMouseEvent, edge: WorkflowCanvasEdge) => {
    event.preventDefault();
    event.stopPropagation();

    setManualSelection({ nodeIds: [], edgeIds: [edge.id] });
    setContextMenu(null);

    const canvasBounds = canvasSectionRef.current?.getBoundingClientRect();
    if (!canvasBounds) {
      setEdgeFloatingPosition(null);
      return;
    }

    setEdgeFloatingPosition(getCanvasFloatingPosition({
      canvasBounds,
      clientX: event.clientX,
      clientY: event.clientY,
      panelWidth: 320,
      panelHeight: 180,
    }));
  }, [setManualSelection]);

  const handleEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: WorkflowCanvasEdge) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selection.edgeIds.includes(edge.id)) {
      setManualSelection({ nodeIds: [], edgeIds: [edge.id] });
    }

    const canvasBounds = canvasSectionRef.current?.getBoundingClientRect();
    if (canvasBounds) {
      setEdgeFloatingPosition(getCanvasFloatingPosition({
        canvasBounds,
        clientX: event.clientX,
        clientY: event.clientY,
        panelWidth: 320,
        panelHeight: 180,
      }));
    }

    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'edge',
      edgeId: edge.id,
    });
  }, [selection.edgeIds, setManualSelection]);

  const selectedKind = selectedNode?.type;
  const selectionCount = selection.nodeIds.length + selection.edgeIds.length;
  const editorPosition = useMemo(() => {
    if (!selectedNode || !canvasSectionRef.current) {
      return null;
    }

    const canvasBounds = canvasSectionRef.current.getBoundingClientRect();
    const node = reactFlowInstance?.getNode(selectedNode.id);
    const screenPosition = reactFlowInstance
      ? reactFlowInstance.flowToScreenPosition(selectedNode.position)
      : {
          x: canvasBounds.left + selectedNode.position.x,
          y: canvasBounds.top + selectedNode.position.y,
        };
    const nodeWidth = node?.width ?? selectedNode.width ?? 260;
    const panelWidth = selectedKind === 'voiceover-generate' ? 430 : 390;
    const panelHeight = selectedKind === 'voiceover-generate' ? 680 : 620;

    let left = screenPosition.x - canvasBounds.left + nodeWidth + 18;
    let top = screenPosition.y - canvasBounds.top - 12;

    if (left + panelWidth > canvasBounds.width - 16) {
      left = Math.max(16, screenPosition.x - canvasBounds.left - panelWidth - 18);
    }

    if (top + panelHeight > canvasBounds.height - 16) {
      top = Math.max(16, canvasBounds.height - panelHeight - 16);
    }

    return {
      left: Math.max(16, left),
      top: Math.max(16, top),
      width: panelWidth,
    };
  }, [reactFlowInstance, selectedKind, selectedNode]);
  const edgeEditorPosition = useMemo<CanvasFloatingPosition | null>(() => {
    if (!selectedEdge || !canvasSectionRef.current) {
      return null;
    }

    if (edgeFloatingPosition) {
      return edgeFloatingPosition;
    }

    const sourceNode = nodes.find((node) => node.id === selectedEdge.source);
    const targetNode = nodes.find((node) => node.id === selectedEdge.target);
    const canvasBounds = canvasSectionRef.current.getBoundingClientRect();

    if (!sourceNode || !targetNode) {
      return {
        left: 16,
        top: 96,
        width: 320,
      };
    }

    const sourceWidth = sourceNode.width ?? 240;
    const sourceHeight = sourceNode.height ?? 140;
    const targetHeight = targetNode.height ?? 140;
    const sourcePoint = reactFlowInstance
      ? reactFlowInstance.flowToScreenPosition({
          x: sourceNode.position.x + sourceWidth,
          y: sourceNode.position.y + sourceHeight / 2,
        })
      : {
          x: canvasBounds.left + sourceNode.position.x + sourceWidth,
          y: canvasBounds.top + sourceNode.position.y + sourceHeight / 2,
        };
    const targetPoint = reactFlowInstance
      ? reactFlowInstance.flowToScreenPosition({
          x: targetNode.position.x,
          y: targetNode.position.y + targetHeight / 2,
        })
      : {
          x: canvasBounds.left + targetNode.position.x,
          y: canvasBounds.top + targetNode.position.y + targetHeight / 2,
        };

    return getCanvasFloatingPosition({
      canvasBounds,
      clientX: (sourcePoint.x + targetPoint.x) / 2,
      clientY: (sourcePoint.y + targetPoint.y) / 2,
      panelWidth: 320,
      panelHeight: 180,
    });
  }, [edgeFloatingPosition, nodes, reactFlowInstance, selectedEdge]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <PreviewMediaContext.Provider value={openPreviewMedia}>
      <div className="min-h-[calc(100vh-4rem)] bg-[#060606] text-white">
        <div className="flex h-[calc(100vh-4rem)]">
        <aside className="flex w-[290px] shrink-0 flex-col border-r border-white/10 bg-black/60">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-3">
              <Link href="/create" className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 hover:bg-white/[0.06]">
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div>
                <div className="text-sm font-semibold">Workflow Canvas</div>
                <div className="text-xs text-zinc-500">Build node-based image, video, motion, and audio flows.</div>
              </div>
            </div>
          </div>

          <div className="border-b border-white/10 px-5 py-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Node palette</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {NODE_LIBRARY.map((item) => (
                <button
                  key={item.type}
                  onClick={() => addNode(item.type)}
                  className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06]"
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Saved canvases</div>
              <button
                onClick={() => void createCanvas()}
                disabled={isCanvasTransitionPending}
                className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                New
              </button>
            </div>
            <div className="space-y-2">
              {canvases.map((canvas) => (
                <div
                  key={canvas.id}
                  className={`rounded-2xl border px-3 py-3 ${canvas.id === activeCanvasId ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-white/10 bg-white/[0.03]'}`}
                >
                  <button
                    className="w-full text-left disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void selectCanvas(canvas)}
                    disabled={isCanvasTransitionPending}
                  >
                    <div className="text-sm font-medium text-white">{canvas.title}</div>
                    <div className="text-xs text-zinc-500">{new Date(canvas.updated_at).toLocaleString()}</div>
                  </button>
                  <button
                    onClick={() => void deleteCanvas(canvas.id)}
                    disabled={isCanvasTransitionPending}
                    className="mt-2 text-xs text-zinc-500 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="sticky top-16 z-40 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-black/85 px-5 py-4 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl supports-[backdrop-filter]:bg-black/70">
            <div className="flex min-w-0 items-center gap-4">
              <input
                value={canvasTitle}
                onChange={(event) => {
                  canvasTitleRef.current = event.target.value;
                  setCanvasTitle(event.target.value);
                  setCanvases((current) => current.map((canvas) => canvas.id === activeCanvasId ? { ...canvas, title: event.target.value } : canvas));
                }}
                onBlur={() => void persistCanvas(canvasTitle)}
                className="min-w-[280px] rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2 text-lg font-semibold outline-none focus:border-emerald-500/40"
              />
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                {saveState === 'saving' ? 'Saving' : saveState === 'dirty' ? 'Unsaved changes' : 'Saved'}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsPlannerOpen(true)}
                className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm text-violet-100 transition hover:bg-violet-500/20"
              >
                <PanelRightOpen className="h-4 w-4" /> Planner
              </button>
              <button onClick={() => void persistCanvas()} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:bg-white/[0.06]">
                <Save className="h-4 w-4" /> Save
              </button>
              {selectedNode && (
                <>
                  <button onClick={() => void runCanvas('node')} className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 hover:bg-emerald-500/20">
                    <Play className="h-4 w-4" /> Run node
                  </button>
                  <button onClick={() => void runCanvas('branch')} className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 hover:bg-sky-500/20">
                    <ZoomIn className="h-4 w-4" /> Run from here
                  </button>
                </>
              )}
              {selection.nodeIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => duplicateSelection()}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:bg-white/[0.06]"
                >
                  <Copy className="h-4 w-4" /> Duplicate
                </button>
              )}
              {selectionCount > 0 && (
                <button
                  type="button"
                  onClick={() => deleteSelection()}
                  className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 hover:bg-rose-500/20"
                >
                  <Trash2 className="h-4 w-4" /> Delete selected
                </button>
              )}
            </div>
          </div>

          <section ref={canvasSectionRef} className="relative min-h-0 flex-1">
            {error && (
              <div className="absolute left-4 top-4 z-20 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                {error}
              </div>
            )}

            {!selectedNode && !selectedEdge && selectionCount > 0 && (
              <CanvasSelectionHud
                selection={selection}
                onDuplicate={() => duplicateSelection()}
                onDelete={() => deleteSelection()}
                onClear={() => clearSelection()}
              />
            )}

            <ReactFlow
              nodes={nodes as never}
              edges={edges as never}
              onNodesChange={onNodesChange as never}
              onEdgesChange={onEdgesChange as never}
              onConnect={handleConnect as never}
              onPaneClick={handlePaneClick as never}
              onPaneContextMenu={handlePaneContextMenu as never}
              onEdgeClick={handleEdgeClick as never}
              onNodeContextMenu={handleNodeContextMenu as never}
              onEdgeContextMenu={handleEdgeContextMenu as never}
              onSelectionChange={({ nodes: nextNodes, edges: nextEdges }: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => {
                const nextNodeIds = nextNodes.map((node) => node.id);
                const nextEdgeIds = nextEdges.map((edge) => edge.id);
                setSelectedNodeIds((current) => areStringArraysEqual(current, nextNodeIds) ? current : nextNodeIds);
                setSelectedEdgeIds((current) => areStringArraysEqual(current, nextEdgeIds) ? current : nextEdgeIds);
                setContextMenu((current) => current ? null : current);
              }}
              onInit={setReactFlowInstance}
              onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
              fitView
              defaultViewport={DEFAULT_VIEWPORT}
              nodeTypes={nodeTypes as never}
              className="dark bg-[#070707]"
              colorMode="dark"
              deleteKeyCode={null}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              selectionKeyCode={['Shift']}
              multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
              panActivationKeyCode="Space"
              panOnDrag={[1]}
              panOnScroll={false}
              zoomOnScroll
              zoomOnPinch
              preventScrolling
              zoomOnDoubleClick={false}
              defaultEdgeOptions={{ animated: true, interactionWidth: 32 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#27272a" />
              <MiniMap
                pannable
                zoomable
                className="!bottom-4 !right-4 !border !border-white/10 !bg-black/80"
                nodeColor={() => '#3f3f46'}
              />
              <Controls className="!bottom-4 !left-4 !border !border-white/10 !bg-black/80" />
            </ReactFlow>

            {selectedNode && editorPosition && (
              <FloatingNodeEditor
                node={selectedNode}
                selectedKind={selectedKind}
                position={editorPosition}
                onUpdateNode={updateNode}
                onUploadAsset={uploadAssetToBucket}
                onDeleteNode={() => deleteSelection({ nodeIds: [selectedNode.id], edgeIds: [] })}
                onOpenPreview={openPreviewMedia}
                onClose={clearSelection}
                onSetError={setError}
              />
            )}

            {!contextMenu && selectedEdge && edgeEditorPosition && (
              <FloatingEdgeEditor
                edge={selectedEdge}
                nodes={nodes}
                position={edgeEditorPosition}
                onDelete={() => deleteSelection({ nodeIds: [], edgeIds: [selectedEdge.id] })}
                onClose={clearSelection}
              />
            )}

            <CanvasContextMenu
              contextMenu={contextMenu}
              selection={selection}
              nodes={nodes}
              edges={edges}
              onClose={() => setContextMenu(null)}
              onDeleteSelection={() => deleteSelection()}
              onDuplicateSelection={() => duplicateSelection()}
              onClearSelection={clearSelection}
              onRunNode={(nodeId) => void runCanvas('node', nodeId)}
              onRunBranch={(nodeId) => void runCanvas('branch', nodeId)}
              onAddNote={(position) => addNode('note', position)}
              onFitView={() => {
                setContextMenu(null);
                void reactFlowInstance?.fitView({ padding: 0.16, duration: 240 });
              }}
              onSelectAll={selectAllElements}
              onOpenPlanner={() => {
                setContextMenu(null);
                setIsPlannerOpen(true);
              }}
            />
          </section>
        </main>
        </div>
      </div>
      <PlannerAssistantDrawer
        isOpen={isPlannerOpen}
        plannerInput={plannerInput}
        plannerError={plannerError}
        generatedBlueprint={generatedBlueprint}
        generatedBlueprintInput={generatedBlueprintInput}
        remainingPlannerCredits={remainingPlannerCredits}
        isGeneratingBlueprint={isGeneratingBlueprint}
        isApplyingBlueprint={isApplyingBlueprint}
        onClose={() => setIsPlannerOpen(false)}
        onInputChange={updatePlannerInput}
        onGenerateBlueprint={generateBlueprint}
        onApplyBlueprint={applyBlueprintToCanvas}
      />
      <WorkflowCanvasStyles />
      <PreviewMediaOverlay preview={previewMedia} onClose={() => setPreviewMedia(null)} />
    </PreviewMediaContext.Provider>
  );
}

function CanvasSelectionHud({
  selection,
  onDuplicate,
  onDelete,
  onClear,
}: {
  selection: CanvasSelectionState;
  onDuplicate: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const nodeCount = selection.nodeIds.length;
  const edgeCount = selection.edgeIds.length;

  return (
    <div data-testid="canvas-selection-hud" className="absolute left-4 top-24 z-20 max-w-md rounded-[28px] border border-white/10 bg-black/85 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-zinc-300">
            <Layers3 className="h-3.5 w-3.5" />
            Selection
          </div>
          <div className="mt-3 text-sm text-zinc-300">
            {nodeCount > 0 ? `${nodeCount} node${nodeCount === 1 ? '' : 's'}` : 'No nodes'}
            {edgeCount > 0 ? ` • ${edgeCount} connection${edgeCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {nodeCount > 0 && (
          <button
            type="button"
            onClick={onDuplicate}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/[0.06]"
          >
            <Copy className="h-4 w-4" /> Duplicate
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      </div>
    </div>
  );
}

function FloatingEdgeEditor({
  edge,
  nodes,
  position,
  onDelete,
  onClose,
}: {
  edge: WorkflowCanvasEdge;
  nodes: WorkflowCanvasNode[];
  position: CanvasFloatingPosition;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute z-30 rounded-[28px] border border-white/10 bg-black/90 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur"
      style={{ left: position.left, top: position.top, width: position.width }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-zinc-300">
            <Layers3 className="h-3.5 w-3.5" />
            Connection
          </div>
          <div className="mt-3 space-y-1 text-sm text-zinc-300">
            <div>From: {getNodeLabel(nodes, edge.source)} ({formatHandleLabel(edge.sourceHandle)})</div>
            <div>To: {getNodeLabel(nodes, edge.target)} ({formatHandleLabel(edge.targetHandle)})</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
          aria-label="Close connection editor"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
        >
          <Trash2 className="h-4 w-4" /> Delete connection
        </button>
      </div>
    </div>
  );
}

function FloatingNodeEditor({
  node,
  selectedKind,
  position,
  onUpdateNode,
  onUploadAsset,
  onDeleteNode,
  onOpenPreview,
  onClose,
  onSetError,
}: {
  node: WorkflowCanvasNode;
  selectedKind: WorkflowNodeKind | undefined;
  position: { left: number; top: number; width: number };
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNodeData>) => void;
  onUploadAsset: (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => Promise<{ signedUrl: string; storagePath: string }>;
  onDeleteNode: () => void;
  onOpenPreview: (preview: PreviewMediaState) => void;
  onClose: () => void;
  onSetError: (message: string | null) => void;
}) {
  return (
    <div
      data-testid="floating-node-editor"
      className="absolute z-30 rounded-[30px] border border-white/10 bg-black/90 shadow-[0_30px_100px_rgba(0,0,0,0.55)] backdrop-blur"
      style={{ left: position.left, top: position.top, width: position.width }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div>
          <div className="text-sm font-semibold text-white">{node.data.title}</div>
          <div className="mt-1 text-xs text-zinc-500">
            {selectedKind === 'text-input' ? 'Prompt node' : selectedKind === 'note' ? 'Canvas note' : node.type.replace(/-/g, ' ')}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close node editor"
          onClick={onClose}
          className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="max-h-[72vh] space-y-4 overflow-y-auto px-5 py-4">
        <div>
          <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Title</label>
          <input
            value={node.data.title}
            onChange={(event) => onUpdateNode(node.id, { ...node.data, title: event.target.value })}
            className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
          />
        </div>

        {(selectedKind === 'text-input' || selectedKind === 'note') && (
          <div>
            <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Content</label>
            <textarea
              rows={8}
              value={((node.data as TextInputNodeData | NoteNodeData).text ?? '') as string}
              onChange={(event) => onUpdateNode(node.id, { ...node.data, text: event.target.value } as Partial<WorkflowNodeData>)}
              className="w-full rounded-3xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
            />
          </div>
        )}

        {selectedKind === 'image-input' && (
          <div className="space-y-3">
            <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Upload image</label>
            <input
              type="file"
              accept="image/*"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  const uploaded = await onUploadAsset(file, 'generated_images');
                  onUpdateNode(node.id, {
                    ...node.data,
                    imageUrl: uploaded.signedUrl,
                    storagePath: uploaded.storagePath,
                  } as Partial<WorkflowNodeData>);
                } catch (uploadError) {
                  onSetError(uploadError instanceof Error ? uploadError.message : 'Image upload failed');
                }
              }}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm"
            />
            {(node.data as ImageInputNodeData).imageUrl && (
              <img
                src={getDisplayMediaUrl((node.data as ImageInputNodeData).storagePath || (node.data as ImageInputNodeData).imageUrl || '')}
                alt=""
                className="w-full rounded-2xl border border-white/10"
              />
            )}
          </div>
        )}

        {selectedKind === 'video-input' && (
          <div className="space-y-3">
            <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Upload video</label>
            <input
              type="file"
              accept="video/*"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  const uploaded = await onUploadAsset(file, 'generated_videos');
                  onUpdateNode(node.id, {
                    ...node.data,
                    videoUrl: uploaded.signedUrl,
                    storagePath: uploaded.storagePath,
                  } as Partial<WorkflowNodeData>);
                } catch (uploadError) {
                  onSetError(uploadError instanceof Error ? uploadError.message : 'Video upload failed');
                }
              }}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm"
            />
            {(node.data as VideoInputNodeData).videoUrl && (
              <video
                src={getDisplayMediaUrl((node.data as VideoInputNodeData).storagePath || (node.data as VideoInputNodeData).videoUrl || '')}
                className="w-full rounded-2xl border border-white/10"
                controls
                muted
                playsInline
              />
            )}
          </div>
        )}

        {selectedKind === 'audio-input' && (
          <div className="space-y-3">
            <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Upload audio</label>
            <input
              type="file"
              accept="audio/*"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  const uploaded = await onUploadAsset(file, 'generated_audio');
                  onUpdateNode(node.id, {
                    ...node.data,
                    audioUrl: uploaded.signedUrl,
                    storagePath: uploaded.storagePath,
                  } as Partial<WorkflowNodeData>);
                } catch (uploadError) {
                  onSetError(uploadError instanceof Error ? uploadError.message : 'Audio upload failed');
                }
              }}
              className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm"
            />
            {(node.data as AudioInputNodeData).audioUrl && (
              <audio
                src={getDisplayMediaUrl((node.data as AudioInputNodeData).storagePath || (node.data as AudioInputNodeData).audioUrl || '')}
                className="w-full rounded-2xl border border-white/10"
                controls
              />
            )}
          </div>
        )}

        {selectedKind === 'image-generate' && (
          <>
            <SelectField
              label="Model"
              value={(node.data as WorkflowNodeData & { model: string }).model}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
              options={['nano-banana-2', 'nano-banana-pro']}
            />
            <SelectField
              label="Aspect ratio"
              value={(node.data as WorkflowNodeData & { aspectRatio: string }).aspectRatio}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, aspectRatio: value } as Partial<WorkflowNodeData>)}
              options={['auto', '1:1', '9:16', '16:9', '4:5']}
            />
            <SelectField
              label="Resolution"
              value={(node.data as WorkflowNodeData & { resolution: string }).resolution}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, resolution: value } as Partial<WorkflowNodeData>)}
              options={['1K', '2K', '4K']}
            />
          </>
        )}

        {selectedKind === 'video-generate' && (
          <>
            <SelectField
              label="Model"
              value={(node.data as VideoGenerateNodeData).model}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
              options={['kling-3.0-video', 'seedance-1.5-pro', 'veo-3.1']}
            />
            <SelectField
              label="Aspect ratio"
              value={(node.data as VideoGenerateNodeData).aspectRatio}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, aspectRatio: value } as Partial<WorkflowNodeData>)}
              options={['9:16', '16:9', '1:1']}
            />
            <NumberField
              label="Duration"
              value={(node.data as VideoGenerateNodeData).duration}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, duration: value } as Partial<WorkflowNodeData>)}
            />
            <SelectField
              label="Mode"
              value={(node.data as VideoGenerateNodeData).mode}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, mode: value } as Partial<WorkflowNodeData>)}
              options={['std', 'pro', 'veo3_fast', 'veo3']}
            />
            <CheckboxField
              label="Native audio"
              checked={(node.data as VideoGenerateNodeData).sound}
              onChange={(checked) => onUpdateNode(node.id, { ...node.data, sound: checked } as Partial<WorkflowNodeData>)}
            />
          </>
        )}

        {selectedKind === 'motion-generate' && (
          <>
            <SelectField
              label="Model"
              value={(node.data as WorkflowNodeData & { model: string }).model}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
              options={['kling-2.6', 'kling-3.0']}
            />
            <SelectField
              label="Resolution"
              value={(node.data as WorkflowNodeData & { mode: string }).mode}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, mode: value } as Partial<WorkflowNodeData>)}
              options={['720p', '1080p']}
            />
            <SelectField
              label="Character orientation"
              value={(node.data as WorkflowNodeData & { characterOrientation: string }).characterOrientation}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, characterOrientation: value } as Partial<WorkflowNodeData>)}
              options={['video', 'image']}
            />
          </>
        )}

        {selectedKind === 'voiceover-generate' && (
          <>
            <SelectField
              label="Model"
              value={(node.data as VoiceoverGenerateNodeData).model}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
              options={[...VOICEOVER_MODEL_OPTIONS]}
            />
            <TextField
              label="Language code"
              value={(node.data as VoiceoverGenerateNodeData).languageCode}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, languageCode: value } as Partial<WorkflowNodeData>)}
            />
            <NumberField
              label="Stability"
              value={(node.data as VoiceoverGenerateNodeData).stability}
              min={0}
              max={1}
              step={0.1}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, stability: value } as Partial<WorkflowNodeData>)}
            />

            {(node.data as VoiceoverGenerateNodeData).model === 'text-to-dialogue-v3' ? (
              <>
                <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-sm text-cyan-100">
                  Dialogue mode owns its own turns here. Connected prompt text stays visible in the graph but is ignored when this model runs.
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs uppercase tracking-[0.18em] text-zinc-500">Dialogue turns</label>
                    <button
                      type="button"
                      onClick={() => {
                        const current = (node.data as VoiceoverGenerateNodeData).dialogueTurns;
                        const nextTurn: DialogueTurn = {
                          id: `turn-${crypto.randomUUID()}`,
                          voice: `Speaker ${current.length + 1}`,
                          text: '',
                        };
                        onUpdateNode(node.id, {
                          ...node.data,
                          dialogueTurns: [...current, nextTurn],
                        } as Partial<WorkflowNodeData>);
                      }}
                      className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-zinc-200 hover:bg-white/[0.08]"
                    >
                      Add turn
                    </button>
                  </div>
                  {(node.data as VoiceoverGenerateNodeData).dialogueTurns.map((turn, index) => (
                    <div key={turn.id} className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Turn {index + 1}</div>
                        {(node.data as VoiceoverGenerateNodeData).dialogueTurns.length > 1 && (
                          <button
                            type="button"
                            onClick={() => onUpdateNode(node.id, {
                              ...node.data,
                              dialogueTurns: (node.data as VoiceoverGenerateNodeData).dialogueTurns.filter((candidate) => candidate.id !== turn.id),
                            } as Partial<WorkflowNodeData>)}
                            className="text-xs text-rose-300 hover:text-rose-200"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <TextField
                        label="Voice name"
                        value={turn.voice}
                        onChange={(value) => onUpdateNode(node.id, {
                          ...node.data,
                          dialogueTurns: (node.data as VoiceoverGenerateNodeData).dialogueTurns.map((candidate) =>
                            candidate.id === turn.id ? { ...candidate, voice: value } : candidate
                          ),
                        } as Partial<WorkflowNodeData>)}
                      />
                      <TextAreaField
                        label="Dialogue text"
                        value={turn.text}
                        onChange={(value) => onUpdateNode(node.id, {
                          ...node.data,
                          dialogueTurns: (node.data as VoiceoverGenerateNodeData).dialogueTurns.map((candidate) =>
                            candidate.id === turn.id ? { ...candidate, text: value } : candidate
                          ),
                        } as Partial<WorkflowNodeData>)}
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <TextField
                  label="Voice name"
                  value={(node.data as VoiceoverGenerateNodeData).voice}
                  onChange={(value) => onUpdateNode(node.id, { ...node.data, voice: value } as Partial<WorkflowNodeData>)}
                />
                <NumberField
                  label="Similarity boost"
                  value={(node.data as VoiceoverGenerateNodeData).similarityBoost}
                  min={0}
                  max={1}
                  step={0.1}
                  onChange={(value) => onUpdateNode(node.id, { ...node.data, similarityBoost: value } as Partial<WorkflowNodeData>)}
                />
                <NumberField
                  label="Style"
                  value={(node.data as VoiceoverGenerateNodeData).style}
                  min={0}
                  max={1}
                  step={0.1}
                  onChange={(value) => onUpdateNode(node.id, { ...node.data, style: value } as Partial<WorkflowNodeData>)}
                />
                <NumberField
                  label="Speed"
                  value={(node.data as VoiceoverGenerateNodeData).speed}
                  min={0.5}
                  max={2}
                  step={0.1}
                  onChange={(value) => onUpdateNode(node.id, { ...node.data, speed: value } as Partial<WorkflowNodeData>)}
                />
                <CheckboxField
                  label="Return timestamps"
                  checked={(node.data as VoiceoverGenerateNodeData).timestamps}
                  onChange={(checked) => onUpdateNode(node.id, { ...node.data, timestamps: checked } as Partial<WorkflowNodeData>)}
                />
              </>
            )}
          </>
        )}

        {selectedKind === 'music-generate' && (
          <>
            <NumberField
              label="Duration"
              value={(node.data as MusicGenerateNodeData).duration}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, duration: value } as Partial<WorkflowNodeData>)}
            />
            <TextField
              label="Mood"
              value={(node.data as MusicGenerateNodeData).mood}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, mood: value } as Partial<WorkflowNodeData>)}
            />
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
              Music node routing is ready in the canvas. Actual music generation still needs a backend provider.
            </div>
          </>
        )}

        {selectedKind === 'sound-effects-generate' && (
          <>
            <SelectField
              label="Model"
              value={(node.data as SoundEffectsGenerateNodeData).model}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
              options={['sound-effect-v2']}
            />
            <NumberField
              label="Duration"
              value={(node.data as SoundEffectsGenerateNodeData).duration}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, duration: value } as Partial<WorkflowNodeData>)}
            />
            <CheckboxField
              label="Loop"
              checked={(node.data as SoundEffectsGenerateNodeData).loop}
              onChange={(checked) => onUpdateNode(node.id, { ...node.data, loop: checked } as Partial<WorkflowNodeData>)}
            />
            <NumberField
              label="Prompt influence"
              value={(node.data as SoundEffectsGenerateNodeData).promptInfluence}
              min={0}
              max={1}
              step={0.1}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, promptInfluence: value } as Partial<WorkflowNodeData>)}
            />
            <SelectField
              label="Output format"
              value={(node.data as SoundEffectsGenerateNodeData).outputFormat}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, outputFormat: value } as Partial<WorkflowNodeData>)}
              options={['mp3', 'wav']}
            />
          </>
        )}

        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Latest run</div>
          <div className="mt-3 space-y-2 text-sm text-zinc-300">
            <div>Status: {node.data.runState.status}</div>
            <div>Generation ID: {node.data.runState.generationId || 'None yet'}</div>
            <div>Cost: {node.data.runState.cost ?? 'N/A'}</div>
            {node.data.runState.error && <div className="text-rose-300">{node.data.runState.error}</div>}
          </div>
          {node.data.runState.outputUrl && (
            <button
              type="button"
              onClick={() => onOpenPreview({
                kind: getNodePreviewKind(node.type as WorkflowNodeKind),
                url: getDisplayMediaUrl(node.data.runState.outputUrl || ''),
                title: node.data.title,
              })}
              className="mt-4 inline-flex items-center justify-center rounded-full border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20"
            >
              Open output
            </button>
          )}
        </div>

        <button onClick={onDeleteNode} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100 hover:bg-rose-500/20">
          <Trash2 className="h-4 w-4" /> Delete selected node
        </button>
      </div>
    </div>
  );
}

function PlannerAssistantDrawer({
  isOpen,
  onClose,
  plannerInput,
  plannerError,
  generatedBlueprint,
  generatedBlueprintInput,
  remainingPlannerCredits,
  isGeneratingBlueprint,
  isApplyingBlueprint,
  onInputChange,
  onGenerateBlueprint,
  onApplyBlueprint,
}: {
  isOpen: boolean;
  onClose: () => void;
  plannerInput: WorkflowPlannerInput;
  plannerError: string | null;
  generatedBlueprint: WorkflowBlueprint | null;
  generatedBlueprintInput: WorkflowPlannerInput | null;
  remainingPlannerCredits: number | null;
  isGeneratingBlueprint: boolean;
  isApplyingBlueprint: boolean;
  onInputChange: (field: keyof WorkflowPlannerInput, value: WorkflowPlannerInput[keyof WorkflowPlannerInput]) => void;
  onGenerateBlueprint: () => Promise<void>;
  onApplyBlueprint: () => Promise<void>;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close planner"
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside data-testid="planner-assistant-drawer" className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col border-l border-white/10 bg-[#050505] shadow-[-32px_0_120px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-violet-500/30 bg-violet-500/10 p-3 text-violet-100">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">Workflow planner</div>
              <div className="mt-1 text-sm text-zinc-400">Turn a campaign brief into a fresh canvas blueprint without leaving the workflow view.</div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close planner drawer"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-white/10 px-5 py-4">
          <div className="rounded-[28px] border border-violet-500/20 bg-violet-500/10 p-4 text-sm text-violet-50">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-black/30 p-2 text-violet-100">
                <Bot className="h-4 w-4" />
              </div>
              <div className="leading-relaxed">
                Share the campaign brief, desired platform, and creative angle. I&apos;ll shape it into a production-ready workflow with shot prompts and a one-click canvas handoff.
              </div>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <WorkflowPlannerTab
            plannerInput={plannerInput}
            plannerError={plannerError}
            generatedBlueprint={generatedBlueprint}
            generatedBlueprintInput={generatedBlueprintInput}
            remainingPlannerCredits={remainingPlannerCredits}
            isGeneratingBlueprint={isGeneratingBlueprint}
            isApplyingBlueprint={isApplyingBlueprint}
            onInputChange={onInputChange}
            onGenerateBlueprint={onGenerateBlueprint}
            onApplyBlueprint={onApplyBlueprint}
          />
        </div>
      </aside>
    </div>
  );
}

function CanvasContextMenu({
  contextMenu,
  selection,
  nodes,
  edges,
  onClose,
  onDeleteSelection,
  onDuplicateSelection,
  onClearSelection,
  onRunNode,
  onRunBranch,
  onAddNote,
  onFitView,
  onSelectAll,
  onOpenPlanner,
}: {
  contextMenu: CanvasContextMenuState | null;
  selection: CanvasSelectionState;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  onClose: () => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onClearSelection: () => void;
  onRunNode: (nodeId: string) => void;
  onRunBranch: (nodeId: string) => void;
  onAddNote: (position: { x: number; y: number }) => void;
  onFitView: () => void;
  onSelectAll: () => void;
  onOpenPlanner: () => void;
}) {
  if (!contextMenu) {
    return null;
  }

  const selectionCount = selection.nodeIds.length + selection.edgeIds.length;
  const isSelectionMenu = contextMenu.target !== 'pane' && selectionCount > 1;
  const node = contextMenu.nodeId ? nodes.find((candidate) => candidate.id === contextMenu.nodeId) || null : null;
  const edge = contextMenu.edgeId ? edges.find((candidate) => candidate.id === contextMenu.edgeId) || null : null;
  const actionClassName = 'flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-200 transition hover:bg-white/[0.06]';

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        data-testid="canvas-context-menu"
        className="absolute min-w-[240px] rounded-[24px] border border-white/10 bg-black/95 p-3 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 px-2">
          <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            {contextMenu.target === 'pane' ? 'Canvas' : isSelectionMenu ? 'Selection' : contextMenu.target === 'node' ? 'Node' : 'Connection'}
          </div>
          <div className="mt-1 text-sm text-zinc-200">
            {contextMenu.target === 'pane'
              ? 'Common actions'
              : isSelectionMenu
                ? `${selection.nodeIds.length} node${selection.nodeIds.length === 1 ? '' : 's'}${selection.edgeIds.length ? ` • ${selection.edgeIds.length} connection${selection.edgeIds.length === 1 ? '' : 's'}` : ''}`
                : node
                  ? node.data.title
                  : edge
                    ? `${getNodeLabel(nodes, edge.source)} → ${getNodeLabel(nodes, edge.target)}`
                    : 'Quick actions'}
          </div>
        </div>

        <div className="space-y-2">
          {contextMenu.target === 'pane' && (
            <>
              <button type="button" onClick={() => { onClose(); onAddNote(contextMenu.flowPosition || { x: 240, y: 240 }); }} className={actionClassName}>
                <span>Add note</span>
                <Plus className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onFitView(); }} className={actionClassName}>
                <span>Fit view</span>
                <ZoomIn className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onSelectAll(); }} className={actionClassName}>
                <span>Select all</span>
                <Layers3 className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onOpenPlanner(); }} className={actionClassName}>
                <span>Open planner</span>
                <Bot className="h-4 w-4 text-zinc-500" />
              </button>
            </>
          )}

          {isSelectionMenu && (
            <>
              {selection.nodeIds.length > 0 && (
                <button type="button" onClick={() => { onClose(); onDuplicateSelection(); }} className={actionClassName}>
                  <span>Duplicate selected</span>
                  <Copy className="h-4 w-4 text-zinc-500" />
                </button>
              )}
              <button type="button" onClick={() => { onClose(); onDeleteSelection(); }} className={actionClassName}>
                <span>Delete selected</span>
                <Trash2 className="h-4 w-4 text-rose-300" />
              </button>
              <button type="button" onClick={() => { onClose(); onClearSelection(); }} className={actionClassName}>
                <span>Clear selection</span>
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </>
          )}

          {!isSelectionMenu && contextMenu.target === 'node' && node && (
            <>
              <button type="button" onClick={() => { onClose(); onRunNode(node.id); }} className={actionClassName}>
                <span>Run node</span>
                <Play className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onRunBranch(node.id); }} className={actionClassName}>
                <span>Run from here</span>
                <ZoomIn className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onDuplicateSelection(); }} className={actionClassName}>
                <span>Duplicate</span>
                <Copy className="h-4 w-4 text-zinc-500" />
              </button>
              <button type="button" onClick={() => { onClose(); onDeleteSelection(); }} className={actionClassName}>
                <span>Delete</span>
                <Trash2 className="h-4 w-4 text-rose-300" />
              </button>
            </>
          )}

          {!isSelectionMenu && contextMenu.target === 'edge' && edge && (
            <button type="button" onClick={() => { onClose(); onDeleteSelection(); }} className={actionClassName}>
              <span>Delete connection</span>
              <Trash2 className="h-4 w-4 text-rose-300" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowCanvasStyles() {
  return (
    <style>{`
      .react-flow {
        --xy-controls-button-background-color: #171717;
        --xy-controls-button-background-color-hover: #262626;
        --xy-controls-button-color: #f4f4f5;
        --xy-controls-button-border-color: rgba(255, 255, 255, 0.1);
        --xy-controls-box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      }

      .react-flow__edge-path {
        transition: stroke-width 140ms ease, filter 140ms ease, opacity 140ms ease;
      }

      .react-flow__edge.selected .react-flow__edge-path {
        stroke-width: 3px;
        filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.35));
      }

      .react-flow__selection {
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(2px);
      }

      .react-flow__controls-button {
        color: #f4f4f5;
        background: #171717;
      }

      .react-flow__controls-button:hover {
        background: #262626;
      }
    `}</style>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <input
        type="text"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <textarea
        aria-label={label}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
    </div>
  );
}

type SelectOption = string | { value: string; label: string };

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      >
        {options.map((option) => {
          const normalized = typeof option === 'string' ? { value: option, label: option } : option;
          return <option key={normalized.value} value={normalized.value}>{normalized.label}</option>;
        })}
      </select>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-200">
      <span>{label}</span>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-white/20 bg-transparent"
      />
    </label>
  );
}

function WorkflowPlannerTab({
  plannerInput,
  plannerError,
  generatedBlueprint,
  generatedBlueprintInput,
  remainingPlannerCredits,
  isGeneratingBlueprint,
  isApplyingBlueprint,
  onInputChange,
  onGenerateBlueprint,
  onApplyBlueprint,
}: {
  plannerInput: WorkflowPlannerInput;
  plannerError: string | null;
  generatedBlueprint: WorkflowBlueprint | null;
  generatedBlueprintInput: WorkflowPlannerInput | null;
  remainingPlannerCredits: number | null;
  isGeneratingBlueprint: boolean;
  isApplyingBlueprint: boolean;
  onInputChange: (field: keyof WorkflowPlannerInput, value: WorkflowPlannerInput[keyof WorkflowPlannerInput]) => void;
  onGenerateBlueprint: () => Promise<void>;
  onApplyBlueprint: () => Promise<void>;
}) {
  const previewInput = generatedBlueprintInput ?? plannerInput;

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-50">
        Generate a production-ready workflow plan from a campaign brief, then turn it into a brand-new canvas without replacing the graph you already have open.
      </div>

      <div className="grid gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Campaign brief</div>
            <div className="mt-1 text-sm text-zinc-300">Each generation costs {WORKFLOW_BLUEPRINT_COST} credits.</div>
          </div>
          {remainingPlannerCredits !== null && (
            <div className="rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs text-zinc-200">
              {remainingPlannerCredits} credits left
            </div>
          )}
        </div>

        <TextField
          label="Brand name"
          value={plannerInput.brandName}
          onChange={(value) => onInputChange('brandName', value)}
          placeholder="Acme Labs"
        />
        <TextField
          label="Product name"
          value={plannerInput.productName}
          onChange={(value) => onInputChange('productName', value)}
          placeholder="Hydrating face mist"
        />
        <TextAreaField
          label="Audience"
          value={plannerInput.audience}
          onChange={(value) => onInputChange('audience', value)}
          placeholder="Busy skincare buyers who want fast proof before purchasing"
        />
        <SelectField
          label="Objective"
          value={plannerInput.objective}
          onChange={(value) => onInputChange('objective', value as WorkflowObjective)}
          options={WORKFLOW_OBJECTIVE_OPTIONS}
        />
        <TextAreaField
          label="Primary message"
          value={plannerInput.primaryMessage}
          onChange={(value) => onInputChange('primaryMessage', value)}
          placeholder="Instant glow without heavy makeup or a long routine"
        />
        <TextField
          label="Offer"
          value={plannerInput.offer}
          onChange={(value) => onInputChange('offer', value)}
          placeholder="20% off first order"
        />
        <TextField
          label="Call to action"
          value={plannerInput.callToAction}
          onChange={(value) => onInputChange('callToAction', value)}
          placeholder="Shop now"
        />
        <TextField
          label="Visual style"
          value={plannerInput.visualStyle}
          onChange={(value) => onInputChange('visualStyle', value)}
          placeholder="Creator-style UGC, natural window light, handheld realism"
        />
        <TextField
          label="Tone"
          value={plannerInput.tone}
          onChange={(value) => onInputChange('tone', value)}
          placeholder="Direct, persuasive, warm"
        />
        <SelectField
          label="Aspect ratio"
          value={plannerInput.aspectRatio}
          onChange={(value) => onInputChange('aspectRatio', value as WorkflowAspectRatio)}
          options={WORKFLOW_ASPECT_RATIO_OPTIONS}
        />
        <NumberField
          label="Target duration"
          value={plannerInput.durationSeconds}
          min={5}
          max={60}
          onChange={(value) => onInputChange('durationSeconds', value)}
        />
        <TextField
          label="Platform"
          value={plannerInput.platform}
          onChange={(value) => onInputChange('platform', value)}
          placeholder="TikTok, Reels, landing page"
        />
        <TextAreaField
          label="Extra notes"
          value={plannerInput.notes || ''}
          onChange={(value) => onInputChange('notes', value)}
          placeholder="Mention proof points, creator persona, mandatory claims, or visual constraints"
          rows={4}
        />

        <button
          type="button"
          onClick={() => void onGenerateBlueprint()}
          disabled={isGeneratingBlueprint || isApplyingBlueprint}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isGeneratingBlueprint ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {isGeneratingBlueprint ? 'Generating blueprint...' : 'Generate workflow blueprint'}
        </button>

        {plannerError && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {plannerError}
          </div>
        )}
      </div>

      {generatedBlueprint ? (
        <div className="space-y-4">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Generated blueprint</div>
                <div className="mt-1 text-lg font-semibold text-white">{generatedBlueprint.title}</div>
                <div className="mt-1 text-sm text-zinc-400">
                  {WORKFLOW_OBJECTIVE_LABELS[previewInput.objective]} for {previewInput.platform}
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 text-sm text-zinc-200">
              <PlannerSummaryCard label="Creative strategy" value={generatedBlueprint.creativeStrategy} />
              <PlannerSummaryCard label="Hook" value={generatedBlueprint.hook} />
              <PlannerSummaryCard label="Narrative" value={generatedBlueprint.narrative} />
              <PlannerSummaryCard label="Voiceover" value={generatedBlueprint.voiceover} />
            </div>

            <button
              type="button"
              onClick={() => void onApplyBlueprint()}
              disabled={isApplyingBlueprint || isGeneratingBlueprint}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm font-medium text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isApplyingBlueprint ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
              {isApplyingBlueprint ? 'Creating canvas...' : 'Create canvas from blueprint'}
            </button>
            <p className="mt-2 text-xs text-zinc-500">This creates a fresh saved canvas so your current workflow stays untouched.</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Delivery plan</div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-200">
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Image: {generatedBlueprint.deliveryPlan.stillImageModel}</span>
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Video: {generatedBlueprint.deliveryPlan.primaryModel}</span>
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Motion: {generatedBlueprint.deliveryPlan.motionModel}</span>
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Format: {previewInput.aspectRatio}</span>
            </div>
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              {generatedBlueprint.deliveryPlan.recommendedSequence.map((step, index) => (
                <div key={`${step}-${index}`} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  {index + 1}. {step}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Editing notes</div>
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              {generatedBlueprint.editingNotes.map((note, index) => (
                <div key={`${note}-${index}`} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  {note}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Asset checklist</div>
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              {generatedBlueprint.assetChecklist.map((asset, index) => (
                <div key={`${asset}-${index}`} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  {asset}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {generatedBlueprint.shots.map((shot, index) => (
              <div key={shot.id} className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Shot {index + 1}</div>
                    <div className="mt-1 text-base font-semibold text-white">{shot.title}</div>
                    <div className="mt-1 text-sm text-zinc-400">{shot.duration}s</div>
                  </div>
                </div>

                <div className="mt-4 space-y-3 text-sm text-zinc-300">
                  <PlannerSummaryCard label="Purpose" value={shot.purpose} />
                  <PlannerSummaryCard label="Beat" value={shot.beat} />
                  <PlannerSummaryCard label="Still prompt" value={shot.visualPrompt} />
                  <PlannerSummaryCard label="Video prompt" value={shot.videoPrompt} />
                  <PlannerSummaryCard label="Motion prompt" value={shot.motionPrompt} />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href={buildImageLaunchUrl(shot.visualPrompt, generatedBlueprint.deliveryPlan.stillImageModel, previewInput.aspectRatio)}
                    className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-100 hover:bg-black/50"
                  >
                    Open image tool
                  </Link>
                  <Link
                    href={buildVideoLaunchUrl(shot.videoPrompt, generatedBlueprint.deliveryPlan.primaryModel, previewInput.aspectRatio, String(shot.duration))}
                    className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-100 hover:bg-black/50"
                  >
                    Open video tool
                  </Link>
                  <Link
                    href={buildMotionLaunchUrl(shot.motionPrompt, generatedBlueprint.deliveryPlan.motionModel)}
                    className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-100 hover:bg-black/50"
                  >
                    Open motion tool
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-sm text-zinc-500">
          Your generated blueprint will appear here with strategy notes, shot prompts, and a one-click action to create a new canvas from it.
        </div>
      )}
    </div>
  );
}

function PlannerSummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className="mt-2 leading-relaxed text-zinc-200">{value}</div>
    </div>
  );
}

function PreviewMediaOverlay({
  preview,
  onClose,
}: {
  preview: PreviewMediaState | null;
  onClose: () => void;
}) {
  if (!preview) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl rounded-[28px] border border-white/10 bg-[#050505] p-4 shadow-[0_32px_120px_rgba(0,0,0,0.65)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-white">{preview.title}</div>
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Press Escape to close</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:bg-white/[0.06]"
          >
            Close
          </button>
        </div>

        {preview.kind === 'image' && (
          <div className="overflow-auto rounded-3xl border border-white/10 bg-black/60 p-4">
            <img src={preview.url} alt={preview.title} className="mx-auto max-h-[76vh] max-w-full rounded-2xl object-contain" />
          </div>
        )}

        {preview.kind === 'video' && (
          <div className="rounded-3xl border border-white/10 bg-black/60 p-4">
            <video src={preview.url} controls autoPlay className="max-h-[76vh] w-full rounded-2xl" />
          </div>
        )}

        {preview.kind === 'audio' && (
          <div className="rounded-3xl border border-white/10 bg-black/60 p-8">
            <audio src={preview.url} controls autoPlay className="w-full" />
          </div>
        )}
      </div>
    </div>
  );
}

function getNodeLabel(nodes: WorkflowCanvasGraph['nodes'], nodeId: string): string {
  return nodes.find((node) => node.id === nodeId)?.data.title || 'Unknown node';
}

function getNodePreviewKind(nodeType: WorkflowNodeKind): PreviewMediaKind {
  if (nodeType === 'image-input' || nodeType === 'image-generate') {
    return 'image';
  }

  if (nodeType === 'video-input' || nodeType === 'video-generate' || nodeType === 'motion-generate') {
    return 'video';
  }

  return 'audio';
}

function formatHandleLabel(handle: string | null | undefined): string {
  if (!handle) {
    return 'default';
  }

  return handle.replace(/-/g, ' ');
}

function NumberField({
  label,
  value,
  min = 1,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
    </div>
  );
}
