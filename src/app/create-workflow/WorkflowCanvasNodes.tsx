'use client';

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';
import {
  Clapperboard,
  FileText,
  Image as ImageIcon,
  MessageSquareText,
  Mic,
  Music,
  Play,
  Plus,
  Trash2,
  Video,
  Volume2,
  Wand2,
} from 'lucide-react';

import { getDisplayMediaUrl } from '@/lib/media-urls';
import { IMAGE_MODELS, VIDEO_MODELS } from '@/lib/models';
import type {
  AudioInputNodeData,
  ImageGenerateNodeData,
  ImageInputNodeData,
  MotionGenerateNodeData,
  MusicGenerateNodeData,
  NoteNodeData,
  SoundEffectsGenerateNodeData,
  TextInputNodeData,
  VideoGenerateNodeData,
  VideoInputNodeData,
  VoiceoverGenerateNodeData,
  WorkflowCanvasEdge,
  WorkflowNodeCapabilityValidation,
  WorkflowNodeData,
  WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import type {
  PreviewMediaKind,
  PreviewMediaState,
} from './workflowCanvasUiTypes';

export interface WorkflowNodeLibraryItem {
  type: WorkflowNodeKind;
  label: string;
  icon: ReactNode;
}

export const WORKFLOW_NODE_LIBRARY: WorkflowNodeLibraryItem[] = [
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

const VOICEOVER_MODEL_LABELS: Record<VoiceoverGenerateNodeData['model'], string> = {
  'text-to-speech-turbo-2-5': 'Turbo 2.5',
  'text-to-speech-multilingual-v2': 'Multilingual V2',
  'text-to-dialogue-v3': 'Dialogue V3',
};

const SOUND_EFFECT_MODEL_LABELS: Record<SoundEffectsGenerateNodeData['model'], string> = {
  'sound-effect-v2': 'Sound Effect V2',
};

const HANDLE_COLORS: Record<string, string> = {
  text: '#f59e0b',
  prompt: '#f59e0b',
  image: '#38bdf8',
  'start-frame': '#38bdf8',
  'end-frame': '#fb7185',
  'reference-image': '#38bdf8',
  'element-image': '#ec4899',
  video: '#22c55e',
  'reference-video': '#22c55e',
  audio: '#a78bfa',
  'reference-audio': '#a78bfa',
};

const HANDLE_SIZE = 12;
const HANDLE_OUTSET = 14;
const HANDLE_RING = '0 0 0 4px rgba(9, 9, 11, 0.92)';
const EDGE_DELETE_HIDE_DELAY_MS = 90;

export interface WorkflowNodeRuntimeData {
  capabilityValidation?: WorkflowNodeCapabilityValidation;
  isRunControlDisabled?: boolean;
  isRunMenuOpen?: boolean;
  onCloseRunMenu?: () => void;
  onDeleteNode?: () => void;
  onOpenRunMenu?: () => void;
  onRunBranch?: () => void;
  onRunNode?: () => void;
  runBranchDisabled?: boolean;
  runMessage?: string | null;
  runNodeDisabled?: boolean;
  showPlayControl?: boolean;
}

interface WorkflowEdgeRuntimeData {
  onDeleteEdge?: (edgeId: string) => void;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

type RuntimeWorkflowNodeData<T extends WorkflowNodeData = WorkflowNodeData> = T & {
  __runtime?: WorkflowNodeRuntimeData;
};

const PreviewMediaContext = createContext<(preview: PreviewMediaState) => void>(() => undefined);

export function WorkflowCanvasPreviewProvider({
  children,
  onOpenPreview,
}: PropsWithChildren<{ onOpenPreview: (preview: PreviewMediaState) => void }>) {
  return (
    <PreviewMediaContext.Provider value={onOpenPreview}>
      {children}
    </PreviewMediaContext.Provider>
  );
}

function getEdgeStrokeColor(edge: Pick<WorkflowCanvasEdge, 'sourceHandle'>): string {
  return HANDLE_COLORS[edge.sourceHandle || ''] || '#d4d4d8';
}

export function decorateWorkflowEdge(
  edge: WorkflowCanvasEdge,
  runtimeData?: WorkflowEdgeRuntimeData
): WorkflowCanvasEdge {
  return {
    ...edge,
    type: edge.type ?? 'workflow',
    animated: edge.animated ?? true,
    interactionWidth: edge.interactionWidth ?? 32,
    data: {
      ...(edge.data || {}),
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
      ...(runtimeData || {}),
    },
    style: {
      stroke: getEdgeStrokeColor(edge),
      strokeWidth: 2,
      ...(edge.style || {}),
    },
  };
}

export function decorateWorkflowNode(
  node: WorkflowCanvasNode,
  runtimeData?: WorkflowNodeRuntimeData
): WorkflowCanvasNode {
  if (!runtimeData) {
    return node;
  }

  return {
    ...node,
    data: {
      ...(node.data as Record<string, unknown>),
      __runtime: runtimeData,
    } as WorkflowNodeData,
  };
}

function getWorkflowNodeRuntimeData<T extends WorkflowNodeData>(data: T): WorkflowNodeRuntimeData | undefined {
  return (data as RuntimeWorkflowNodeData<T>).__runtime;
}

function SourceHandle({
  id,
  top,
}: {
  id: string;
  top: number;
}) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      id={id}
      style={{
        top,
        right: -HANDLE_OUTSET,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        background: HANDLE_COLORS[id] || '#fff',
        border: '2px solid #09090b',
        boxShadow: HANDLE_RING,
      }}
    />
  );
}

function TargetHandle({ id, top, hidden = false }: { id: string; top: number; hidden?: boolean }) {
  return (
    <Handle
      type="target"
      position={Position.Left}
      id={id}
      style={{
        top,
        left: -HANDLE_OUTSET,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        background: HANDLE_COLORS[id] || '#fff',
        border: '2px solid #09090b',
        boxShadow: HANDLE_RING,
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
      }}
    />
  );
}

function NodeShell({
  dragging = false,
  icon,
  title,
  subtitle,
  status,
  minHeight,
  preview,
  runtime,
  children,
}: {
  dragging?: boolean;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  status: string;
  minHeight?: number;
  preview?: ReactNode;
  runtime?: WorkflowNodeRuntimeData;
  children?: ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const showActionRail = Boolean(runtime && (isHovered || runtime.isRunMenuOpen));

  return (
    <div
      className={`workflow-canvas-node-shell group relative min-w-[230px] max-w-[260px] overflow-visible rounded-2xl border border-white/10 bg-[#090909] p-3 ring-1 ring-white/[0.03] ${dragging ? 'shadow-[0_10px_30px_rgba(0,0,0,0.32)]' : 'shadow-[0_18px_48px_rgba(0,0,0,0.42)]'}`}
      style={{
        minHeight,
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        transform: 'translateZ(0)',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {showActionRail && runtime && (
        <div className="nodrag nopan absolute left-1/2 top-0 z-20 flex -translate-x-1/2 -translate-y-[68%] items-center gap-2 rounded-2xl border border-white/12 bg-[#090909]/96 px-2 py-1 shadow-[0_12px_36px_rgba(0,0,0,0.42)] backdrop-blur">
          {runtime.showPlayControl && (
            <div className="relative flex items-center">
              <button
                type="button"
                aria-label="Run node"
                data-testid="workflow-node-action-play"
                disabled={runtime.isRunControlDisabled}
                className="nodrag nopan inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/15 bg-[#090909]/95 text-zinc-100 transition hover:scale-105 hover:border-emerald-400/45 hover:bg-emerald-500/12 hover:text-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  runtime.onOpenRunMenu?.();
                }}
              >
                <Play className="h-4 w-4 fill-current" />
              </button>

              {runtime.isRunMenuOpen && (
                <div
                  data-testid="workflow-node-run-menu"
                  className="nodrag nopan absolute left-1/2 top-0 w-44 -translate-x-1/2 -translate-y-full rounded-2xl border border-white/10 bg-[#090909]/95 p-2 shadow-[0_20px_48px_rgba(0,0,0,0.5)] backdrop-blur"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <div className="space-y-1">
                    {runtime.onRunNode && (
                      <button
                        type="button"
                        aria-label="Run this step"
                        data-testid="workflow-node-run-node"
                        disabled={runtime.runNodeDisabled}
                        className="flex w-full items-center rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-sm text-zinc-100 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          runtime.onRunNode?.();
                        }}
                      >
                        Run this step
                      </button>
                    )}
                    {runtime.onRunBranch && (
                      <button
                        type="button"
                        aria-label="Run from here"
                        data-testid="workflow-node-run-branch"
                        disabled={runtime.runBranchDisabled}
                        className="flex w-full items-center rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-sm text-zinc-100 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          runtime.onRunBranch?.();
                        }}
                      >
                        Run from here
                      </button>
                    )}
                  </div>
                  {runtime.runMessage && (
                    <div className="mt-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-[11px] leading-relaxed text-zinc-400">
                      {runtime.runMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {runtime.onDeleteNode && (
            <button
              type="button"
              aria-label="Delete node"
              data-testid="workflow-node-action-delete"
              className="nodrag nopan inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/15 bg-[#090909]/95 text-zinc-100 transition hover:scale-105 hover:border-rose-400/45 hover:bg-rose-500/12 hover:text-rose-100"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                runtime.onDeleteNode?.();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

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
  disabled = false,
  children,
}: {
  href: string;
  label: string;
  kind: PreviewMediaKind;
  disabled?: boolean;
  children: ReactNode;
}) {
  const openPreview = useContext(PreviewMediaContext);
  const sharedClassName = 'group relative mt-3 block w-full overflow-hidden rounded-xl bg-transparent text-left nodrag nopan';

  if (disabled) {
    return <div className={sharedClassName}>{children}</div>;
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        openPreview({ kind, url: href, title: label });
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className={sharedClassName}
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

function AudioPreview({ url, dragging }: { url: string; dragging?: boolean }) {
  if (dragging) {
    return (
      <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs uppercase tracking-[0.18em] text-zinc-400">
        Audio ready
      </div>
    );
  }

  return <audio src={url} controls className="nodrag nopan mt-3 w-full rounded-xl border border-white/10" />;
}

export function getImageGenerateNodeSummary(data: ImageGenerateNodeData): string[] {
  const details = [data.resolution, data.outputFormat.toUpperCase()];

  if (IMAGE_MODELS[data.model].supportsGoogleSearch && data.googleSearch) {
    details.push('Google Search');
  }

  const summary = [`Aspect ${data.aspectRatio}`, details.join(' • ')];
  if (data.elementBindings.length > 0) {
    summary.push(`Elements ${data.elementBindings.length}`);
  } else if (data.elements.length > 0) {
    summary.push(`Legacy ${data.elements.length}`);
  }

  return summary;
}

export function getImageGenerateNodeSummaryWithCapabilities(
  data: ImageGenerateNodeData,
  capabilityValidation?: WorkflowNodeCapabilityValidation
): string[] {
  const summary = getImageGenerateNodeSummary(data);

  if (capabilityValidation?.referenceImageLimit !== null && capabilityValidation?.referenceImageLimit !== undefined) {
    summary.push(`Refs ${capabilityValidation.referenceImageCount}/${capabilityValidation.referenceImageLimit}`);
    if (capabilityValidation.connectedElementCount > 0) {
      summary.push(`Elements ${capabilityValidation.connectedElementCount}`);
    } else if (capabilityValidation.legacyElementCount > 0) {
      summary.push(`Legacy ${capabilityValidation.legacyElementCount}`);
    }
    if (capabilityValidation.namedElementCount > 0) {
      summary.push(`Budget ${capabilityValidation.totalReferenceImageCount}/${capabilityValidation.referenceImageLimit}`);
    }
  }

  return summary;
}

export function getVideoGenerateNodeSummary(data: VideoGenerateNodeData): string[] {
  const model = VIDEO_MODELS[data.model];
  const details: string[] = [];
  const activeMode = model.modeOptions.find((option) => option.value === data.mode);

  if (activeMode) {
    details.push(activeMode.label);
  }

  if (model.resolutions.length > 0 && data.resolution) {
    details.push(data.resolution);
  }

  if (model.supportsSound) {
    details.push(data.sound ? 'Native audio on' : 'Silent');
  }

  if (model.supportsFixedLens && data.fixedLens) {
    details.push('Fixed lens');
  }

  const durationLabel = model.durations.length === 1 ? `${data.duration}s fixed` : `${data.duration}s`;
  const summary = [`${data.aspectRatio} • ${durationLabel}`, details.join(' • ')].filter(Boolean);

  if (data.isMultiShot) {
    summary.push(`${data.multiPrompts.length} shots`);
  } else if (data.referenceMode === 'elements') {
    if (data.elementBindings.length > 0) {
      summary.push(`Elements ${data.elementBindings.length}`);
    } else if (data.elements.length > 0) {
      summary.push(`Legacy ${data.elements.length}`);
    } else {
      summary.push('Elements mode');
    }
  } else {
    summary.push('Frames mode');
  }

  return summary;
}

export function getVideoGenerateNodeSummaryWithCapabilities(
  data: VideoGenerateNodeData,
  capabilityValidation?: WorkflowNodeCapabilityValidation
): string[] {
  const summary = getVideoGenerateNodeSummary(data);

  if (capabilityValidation) {
    if (capabilityValidation.isMultiShot) {
      summary.push(`Frames: start${capabilityValidation.endFrameCount > 0 ? '/end' : ''}`);
    } else if (capabilityValidation.activeReferenceMode === 'elements') {
      if (capabilityValidation.connectedElementCount > 0) {
        summary.push(
          `Elements ${capabilityValidation.connectedElementCount}/${capabilityValidation.namedElementLimit ?? capabilityValidation.connectedElementCount}`
        );
      } else if (capabilityValidation.legacyElementCount > 0) {
        summary.push(`Legacy ${capabilityValidation.legacyElementCount}`);
      }
    } else {
      const frameLabel = capabilityValidation.endFrameCount > 0 ? 'start/end' : capabilityValidation.startFrameCount > 0 ? 'start' : 'none';
      summary.push(`Frames: ${frameLabel}`);
    }
  }

  return summary;
}

export function getMotionGenerateNodeSummary(
  data: MotionGenerateNodeData,
  capabilityValidation?: WorkflowNodeCapabilityValidation
): string[] {
  const summary = [`${data.mode} • ${data.characterOrientation}`];

  if (
    capabilityValidation &&
    capabilityValidation.referenceImageLimit !== null &&
    capabilityValidation.referenceVideoLimit !== null
  ) {
    summary.push(
      `Image refs ${capabilityValidation.referenceImageCount}/${capabilityValidation.referenceImageLimit} • Video refs ${capabilityValidation.referenceVideoCount}/${capabilityValidation.referenceVideoLimit}`
    );
  }

  if (capabilityValidation?.referenceVideoDurationLimitSeconds) {
    summary.push(`${capabilityValidation.referenceVideoDurationLimitSeconds}s ref max`);
  }

  return summary;
}

const TextInputNode = memo(function TextInputNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<TextInputNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  return (
    <NodeShell dragging={dragging} icon={<FileText className="h-4 w-4" />} title={typed.title} subtitle={typed.subtitle} status={typed.runState.status} runtime={runtime}>
      <TargetHandle id="prompt" top={36} />
      <SourceHandle id="text" top={78} />
      <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-zinc-200">
        {typed.text}
      </div>
    </NodeShell>
  );
});

const NoteNode = memo(function NoteNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<NoteNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  return (
    <NodeShell dragging={dragging} icon={<MessageSquareText className="h-4 w-4" />} title={typed.title} subtitle={typed.subtitle} status={typed.runState.status} runtime={runtime}>
      <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-zinc-300">
        {typed.text}
      </div>
    </NodeShell>
  );
});

const ImageInputNode = memo(function ImageInputNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<ImageInputNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.storagePath
    ? getDisplayMediaUrl(typed.storagePath)
    : typed.imageUrl
      ? getDisplayMediaUrl(typed.imageUrl)
      : null;

  return (
    <NodeShell
      dragging={dragging}
      icon={<ImageIcon className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 108}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open image input preview" kind="image" disabled={dragging}>
          <img src={previewUrl} alt="" className={`h-28 w-full rounded-xl border border-white/10 object-cover ${dragging ? '' : 'transition group-hover:scale-[1.02]'}`} />
        </PreviewMediaLink>
      ) : undefined}
    >
      <SourceHandle id="image" top={92} />
      {!typed.imageUrl && (
        <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">
          Upload an image or connect one here.
        </div>
      )}
    </NodeShell>
  );
});

const VideoInputNode = memo(function VideoInputNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<VideoInputNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.storagePath
    ? getDisplayMediaUrl(typed.storagePath)
    : typed.videoUrl
      ? getDisplayMediaUrl(typed.videoUrl)
      : null;

  return (
    <NodeShell
      dragging={dragging}
      icon={<Video className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 108}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open video input preview" kind="video" disabled={dragging}>
          <video src={previewUrl} className="h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline />
        </PreviewMediaLink>
      ) : undefined}
    >
      <SourceHandle id="video" top={92} />
      {!typed.videoUrl && (
        <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">
          Upload a reference video or connect one here.
        </div>
      )}
    </NodeShell>
  );
});

const AudioInputNode = memo(function AudioInputNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<AudioInputNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.storagePath
    ? getDisplayMediaUrl(typed.storagePath)
    : typed.audioUrl
      ? getDisplayMediaUrl(typed.audioUrl)
      : null;

  return (
    <NodeShell
      dragging={dragging}
      icon={<Volume2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 108}
      preview={previewUrl ? <AudioPreview url={previewUrl} dragging={dragging} /> : undefined}
    >
      <SourceHandle id="audio" top={92} />
      {!typed.audioUrl && (
        <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">
          Upload a track or connect future audio outputs here.
        </div>
      )}
    </NodeShell>
  );
});

const ImageGenerateNode = memo(function ImageGenerateNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<ImageGenerateNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  const summaryLines = getImageGenerateNodeSummaryWithCapabilities(typed, runtime?.capabilityValidation);

  return (
    <NodeShell
      dragging={dragging}
      icon={<ImageIcon className="h-4 w-4" />}
      title={typed.title}
      subtitle={IMAGE_MODELS[typed.model].displayName}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 132}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open generated image" kind="image" disabled={dragging}>
          <img src={previewUrl} alt="" className={`h-28 w-full rounded-xl border border-white/10 object-cover ${dragging ? '' : 'transition group-hover:scale-[1.02]'}`} />
        </PreviewMediaLink>
      ) : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <TargetHandle id="reference-image" top={78} />
      <TargetHandle id="element-image" top={118} />
      <SourceHandle id="image" top={154} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        {summaryLines.map((line) => (
          <div key={`${typed.model}-${line}`}>{line}</div>
        ))}
      </div>
    </NodeShell>
  );
});

const VideoGenerateNode = memo(function VideoGenerateNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<VideoGenerateNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  const summaryLines = getVideoGenerateNodeSummaryWithCapabilities(typed, runtime?.capabilityValidation);

  return (
    <NodeShell
      dragging={dragging}
      icon={<Clapperboard className="h-4 w-4" />}
      title={typed.title}
      subtitle={VIDEO_MODELS[typed.model].displayName}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 156}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open generated video" kind="video" disabled={dragging}>
          <video src={previewUrl} className="h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline />
        </PreviewMediaLink>
      ) : undefined}
    >
      <TargetHandle id="prompt" top={34} />
      <TargetHandle id="start-frame" top={68} />
      <TargetHandle id="reference-image" top={68} hidden />
      <TargetHandle id="end-frame" top={102} />
      <TargetHandle id="element-image" top={136} />
      <SourceHandle id="video" top={176} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        {summaryLines.map((line) => (
          <div key={`${typed.model}-${line}`}>{line}</div>
        ))}
      </div>
    </NodeShell>
  );
});

const MotionGenerateNode = memo(function MotionGenerateNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<MotionGenerateNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;
  const summaryLines = getMotionGenerateNodeSummary(typed, runtime?.capabilityValidation);

  return (
    <NodeShell
      dragging={dragging}
      icon={<Wand2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 160}
      preview={previewUrl ? (
        <PreviewMediaLink href={previewUrl} label="Open motion output" kind="video" disabled={dragging}>
          <video src={previewUrl} className="h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline />
        </PreviewMediaLink>
      ) : undefined}
    >
      <TargetHandle id="reference-image" top={34} />
      <TargetHandle id="reference-video" top={72} />
      <TargetHandle id="prompt" top={110} />
      <SourceHandle id="video" top={146} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        {summaryLines.map((line) => (
          <div key={`${typed.model}-${line}`}>{line}</div>
        ))}
      </div>
    </NodeShell>
  );
});

const VoiceoverGenerateNode = memo(function VoiceoverGenerateNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<VoiceoverGenerateNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const isDialogueModel = typed.model === 'text-to-dialogue-v3';
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;

  return (
    <NodeShell
      dragging={dragging}
      icon={<Mic className="h-4 w-4" />}
      title={typed.title}
      subtitle={VOICEOVER_MODEL_LABELS[typed.model] || typed.model}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 100}
      preview={previewUrl ? <AudioPreview url={previewUrl} dragging={dragging} /> : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <SourceHandle id="audio" top={86} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{isDialogueModel ? `${typed.dialogueTurns.length} dialogue turn${typed.dialogueTurns.length === 1 ? '' : 's'}` : typed.voice}</div>
        <div>Language {typed.languageCode}</div>
      </div>
    </NodeShell>
  );
});

const MusicGenerateNode = memo(function MusicGenerateNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<MusicGenerateNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;

  return (
    <NodeShell
      dragging={dragging}
      icon={<Music className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 100}
      preview={previewUrl ? <AudioPreview url={previewUrl} dragging={dragging} /> : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <SourceHandle id="audio" top={86} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{typed.duration}s</div>
        <div>{typed.mood}</div>
      </div>
    </NodeShell>
  );
});

const SoundEffectsGenerateNode = memo(function SoundEffectsGenerateNode({ data, dragging }: NodeProps) {
  const typed = data as unknown as RuntimeWorkflowNodeData<SoundEffectsGenerateNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  const previewUrl = typed.runState.outputUrl ? getDisplayMediaUrl(typed.runState.outputUrl) : null;

  return (
    <NodeShell
      dragging={dragging}
      icon={<Volume2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={SOUND_EFFECT_MODEL_LABELS[typed.model] || typed.model}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={previewUrl ? undefined : 100}
      preview={previewUrl ? <AudioPreview url={previewUrl} dragging={dragging} /> : undefined}
    >
      <TargetHandle id="prompt" top={38} />
      <SourceHandle id="audio" top={86} />
      <div className="mt-3 grid gap-2 text-[11px] text-zinc-400">
        <div>{typed.duration}s • {typed.outputFormat.toUpperCase()}</div>
        <div>{typed.loop ? 'Loop enabled' : 'One-shot'} • Influence {typed.promptInfluence}</div>
      </div>
    </NodeShell>
  );
});

const GroupNode = memo(function GroupNode({ data }: NodeProps) {
  const typed = data as RuntimeWorkflowNodeData<WorkflowNodeData>;
  const runtime = getWorkflowNodeRuntimeData(typed);
  return (
    <NodeShell
      icon={<Plus className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      runtime={runtime}
      minHeight={96}
    >
      <div className="mt-3 rounded-2xl border border-dashed border-amber-400/25 bg-amber-500/[0.04] px-4 py-3 text-sm text-amber-100">
        {typed.title}
      </div>
    </NodeShell>
  );
});

function WorkflowInsertEdge({
  data,
  id,
  markerEnd,
  selected,
  sourceX,
  sourceY,
  style,
  targetX,
  targetY,
}: EdgeProps<WorkflowCanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  const runtimeData = (data || {}) as WorkflowEdgeRuntimeData;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showDeleteControl, setShowDeleteControl] = useState(false);
  const baseStrokeWidth = typeof style?.strokeWidth === 'number' ? style.strokeWidth : 2;
  const edgeStyle = {
    ...style,
    strokeWidth: selected || showDeleteControl ? baseStrokeWidth + 0.8 : baseStrokeWidth,
    filter: selected || showDeleteControl
      ? `drop-shadow(0 0 10px ${style?.stroke || 'rgba(255,255,255,0.28)'})`
      : style?.filter,
  };

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const handleHoverStart = () => {
    clearHideTimer();
    setShowDeleteControl(true);
  };

  const handleHoverEnd = () => {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      setShowDeleteControl(false);
      hideTimerRef.current = null;
    }, EDGE_DELETE_HIDE_DELAY_MS);
  };

  useEffect(() => () => clearHideTimer(), []);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={edgeStyle}
      />
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={28}
        data-testid={`workflow-edge-hover-zone-${id}`}
        style={{ pointerEvents: 'stroke' }}
        onMouseEnter={handleHoverStart}
        onMouseMove={handleHoverStart}
        onMouseLeave={handleHoverEnd}
      />
      {runtimeData.onDeleteEdge && showDeleteControl && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute left-0 top-0 z-20"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <button
              type="button"
              aria-label="Delete connection"
              data-testid={`workflow-edge-delete-${id}`}
              className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-xl border border-white/15 bg-[#090909]/95 text-zinc-200 shadow-[0_12px_36px_rgba(0,0,0,0.42)] backdrop-blur transition hover:scale-105 hover:border-rose-400/45 hover:bg-rose-500/12 hover:text-rose-100"
              onMouseEnter={handleHoverStart}
              onMouseLeave={handleHoverEnd}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                runtimeData.onDeleteEdge?.(id);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const workflowCanvasNodeTypes = {
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

export const workflowCanvasEdgeTypes = {
  workflow: WorkflowInsertEdge,
};
