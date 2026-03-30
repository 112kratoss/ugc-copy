'use client';

import {
  createContext,
  useContext,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  Handle,
  Position,
  type NodeProps,
} from '@xyflow/react';
import {
  Clapperboard,
  FileText,
  Image as ImageIcon,
  MessageSquareText,
  Mic,
  Music,
  Plus,
  Video,
  Volume2,
  Wand2,
} from 'lucide-react';

import { getDisplayMediaUrl } from '@/lib/media-urls';
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
  WorkflowCanvasNode,
  WorkflowNodeData,
  WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import type { PreviewMediaKind, PreviewMediaState } from './workflowCanvasUiTypes';

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
  'reference-image': '#38bdf8',
  video: '#22c55e',
  'reference-video': '#22c55e',
  audio: '#a78bfa',
  'reference-audio': '#a78bfa',
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

export function decorateWorkflowEdge(edge: WorkflowCanvasEdge): WorkflowCanvasEdge {
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
  return (
    <Handle
      type="source"
      position={Position.Right}
      id={id}
      style={{
        top,
        right: -6,
        width: 12,
        height: 12,
        background: HANDLE_COLORS[id] || '#fff',
        border: '2px solid #09090b',
      }}
    />
  );
}

function TargetHandle({ id, top }: { id: string; top: number }) {
  return (
    <Handle
      type="target"
      position={Position.Left}
      id={id}
      style={{
        top,
        left: -6,
        width: 12,
        height: 12,
        background: HANDLE_COLORS[id] || '#fff',
        border: '2px solid #09090b',
      }}
    />
  );
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
  const previewUrl = typed.storagePath
    ? getDisplayMediaUrl(typed.storagePath)
    : typed.imageUrl
      ? getDisplayMediaUrl(typed.imageUrl)
      : null;

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
      {!typed.imageUrl && (
        <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">
          Upload an image or connect one here.
        </div>
      )}
    </NodeShell>
  );
}

function VideoInputNode({ data }: NodeProps) {
  const typed = data as unknown as VideoInputNodeData;
  const previewUrl = typed.storagePath
    ? getDisplayMediaUrl(typed.storagePath)
    : typed.videoUrl
      ? getDisplayMediaUrl(typed.videoUrl)
      : null;

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
      {!typed.videoUrl && (
        <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">
          Upload a reference video or connect one here.
        </div>
      )}
    </NodeShell>
  );
}

function AudioInputNode({ data }: NodeProps) {
  const typed = data as unknown as AudioInputNodeData;
  const previewUrl = typed.storagePath
    ? getDisplayMediaUrl(typed.storagePath)
    : typed.audioUrl
      ? getDisplayMediaUrl(typed.audioUrl)
      : null;

  return (
    <NodeShell
      icon={<Volume2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      preview={previewUrl ? <audio src={previewUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
    >
      <SourceHandle id="audio" top={92} />
      {!typed.audioUrl && (
        <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">
          Upload a track or connect future audio outputs here.
        </div>
      )}
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
  const typed = data as WorkflowNodeData;
  return (
    <div className="min-w-[250px] rounded-[28px] border border-dashed border-amber-400/25 bg-amber-500/[0.04] px-5 py-4 text-sm text-amber-100 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
      {typed.title}
    </div>
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
