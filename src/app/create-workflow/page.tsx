'use client';

import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Clapperboard, FileText, Image as ImageIcon, Loader2, MessageSquareText, Mic, Music, Play, Plus, Save, Trash2, Video, Volume2, Wand2, ZoomIn } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  type AudioInputNodeData,
  createStarterGraph,
  createWorkflowNode,
  DEFAULT_VIEWPORT,
  type DialogueTurn,
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
  type WorkflowCanvasRecord,
  type WorkflowCanvasRunRecord,
  type WorkflowHandleType,
  type WorkflowNodeData,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';

type SaveState = 'saved' | 'dirty' | 'saving';

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
  return (
    <NodeShell
      icon={<ImageIcon className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      preview={typed.imageUrl ? <img src={typed.imageUrl} alt="" className="mt-3 h-28 w-full rounded-xl border border-white/10 object-cover" /> : undefined}
    >
      <SourceHandle id="image" top={92} />
      {!typed.imageUrl && <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">Upload an image or connect one here.</div>}
    </NodeShell>
  );
}

function VideoInputNode({ data }: NodeProps) {
  const typed = data as unknown as VideoInputNodeData;
  return (
    <NodeShell
      icon={<Video className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      preview={typed.videoUrl ? <video src={typed.videoUrl} className="mt-3 h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline /> : undefined}
    >
      <SourceHandle id="video" top={92} />
      {!typed.videoUrl && <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">Upload a reference video or connect one here.</div>}
    </NodeShell>
  );
}

function AudioInputNode({ data }: NodeProps) {
  const typed = data as unknown as AudioInputNodeData;
  return (
    <NodeShell
      icon={<Volume2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.subtitle}
      status={typed.runState.status}
      preview={typed.audioUrl ? <audio src={typed.audioUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
    >
      <SourceHandle id="audio" top={92} />
      {!typed.audioUrl && <div className="mt-3 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-zinc-500">Upload a track or connect future audio outputs here.</div>}
    </NodeShell>
  );
}

function ImageGenerateNode({ data }: NodeProps) {
  const typed = data as unknown as ImageGenerateNodeData;
  return (
    <NodeShell
      icon={<ImageIcon className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={typed.runState.outputUrl ? <img src={typed.runState.outputUrl} alt="" className="mt-3 h-28 w-full rounded-xl border border-white/10 object-cover" /> : undefined}
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
  return (
    <NodeShell
      icon={<Clapperboard className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={typed.runState.outputUrl ? <video src={typed.runState.outputUrl} className="mt-3 h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline /> : undefined}
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
  return (
    <NodeShell
      icon={<Wand2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={typed.runState.outputUrl ? <video src={typed.runState.outputUrl} className="mt-3 h-28 w-full rounded-xl border border-white/10 object-cover" muted playsInline /> : undefined}
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
  return (
    <NodeShell
      icon={<Mic className="h-4 w-4" />}
      title={typed.title}
      subtitle={VOICEOVER_MODEL_LABELS[typed.model] || typed.model}
      status={typed.runState.status}
      preview={typed.runState.outputUrl ? <audio src={typed.runState.outputUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
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
  return (
    <NodeShell
      icon={<Music className="h-4 w-4" />}
      title={typed.title}
      subtitle={typed.model}
      status={typed.runState.status}
      preview={typed.runState.outputUrl ? <audio src={typed.runState.outputUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
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
  return (
    <NodeShell
      icon={<Volume2 className="h-4 w-4" />}
      title={typed.title}
      subtitle={SOUND_EFFECT_MODEL_LABELS[typed.model] || typed.model}
      status={typed.runState.status}
      preview={typed.runState.outputUrl ? <audio src={typed.runState.outputUrl} controls className="mt-3 w-full rounded-xl border border-white/10" /> : undefined}
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
  const router = useRouter();
  const [canvases, setCanvases] = useState<WorkflowCanvasRecord[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const [canvasTitle, setCanvasTitle] = useState('Workflow canvas');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const autosaveTimer = useRef<NodeJS.Timeout | null>(null);

  const starter = useMemo(() => createStarterGraph(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(starter.edges);

  const graph = useMemo<WorkflowCanvasGraph>(() => ({
    version: starter.version,
    nodes: nodes.map((node) => ({ ...node, data: normalizeNodeData(node.type as WorkflowNodeKind, node.data) })),
    edges,
    viewport,
  }), [nodes, edges, starter.version, viewport]);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) || null, [nodes, selectedNodeId]);

  const syncCanvasState = useCallback((canvas: WorkflowCanvasRecord) => {
    setActiveCanvasId(canvas.id);
    setCanvasTitle(canvas.title);
    setNodes(canvas.graph.nodes);
    setEdges(canvas.graph.edges);
    setViewport(canvas.graph.viewport || DEFAULT_VIEWPORT);
    setSelectedNodeId(null);
    setActiveRunId(null);

    if (reactFlowInstance) {
      requestAnimationFrame(() => {
        void reactFlowInstance.setViewport(canvas.graph.viewport || DEFAULT_VIEWPORT, { duration: 0 });
      });
    }
  }, [reactFlowInstance, setEdges, setNodes]);

  const authHeaders = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Please log in to use the workflow canvas.');
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }, []);

  const loadCanvases = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login?returnUrl=/create-workflow');
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
  }, [authHeaders, router, syncCanvasState]);

  useEffect(() => {
    loadCanvases();
  }, [loadCanvases]);

  useEffect(() => {
    if (!reactFlowInstance) return;
    void reactFlowInstance.setViewport(viewport, { duration: 0 });
  }, [reactFlowInstance, viewport]);

  const persistCanvas = useCallback(async (nextTitle?: string, nextGraph?: WorkflowCanvasGraph) => {
    if (!activeCanvasId) return;
    setSaveState('saving');
    try {
      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}`, {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({
          title: nextTitle ?? canvasTitle,
          graph: nextGraph ?? graph,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save canvas');
      setCanvases((current) => current.map((canvas) => canvas.id === activeCanvasId ? data.canvas : canvas));
      setSaveState('saved');
    } catch (saveError) {
      setSaveState('dirty');
      setError(saveError instanceof Error ? saveError.message : 'Failed to save canvas');
    }
  }, [activeCanvasId, authHeaders, canvasTitle, graph]);

  useEffect(() => {
    if (!activeCanvasId || isLoading) return;
    setSaveState('dirty');
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void persistCanvas();
    }, 900);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [activeCanvasId, graph, isLoading, persistCanvas, canvasTitle]);

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

    const stroke = HANDLE_COLORS[connection.sourceHandle || ''] || '#ffffff';
    setEdges((current) =>
      addEdge({
        ...connection,
        animated: true,
        style: { stroke, strokeWidth: 2 },
      }, current)
    );
  }, [setEdges]);

  const addNode = useCallback((type: WorkflowNodeKind) => {
    const position = reactFlowInstance
      ? reactFlowInstance.screenToFlowPosition({ x: 420, y: 280 })
      : { x: 300, y: 220 };
    setNodes((current) => [...current, createWorkflowNode(type, position)]);
  }, [reactFlowInstance, setNodes]);

  const removeSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  }, [selectedNodeId, setEdges, setNodes]);

  const createCanvas = useCallback(async () => {
    try {
      const response = await fetch('/api/workflow-canvases', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          title: `Workflow ${canvases.length + 1}`,
          graph: createStarterGraph(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to create canvas');
      setCanvases((current) => [data.canvas, ...current]);
      syncCanvasState(data.canvas);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create canvas');
    }
  }, [authHeaders, canvases.length, syncCanvasState]);

  useEffect(() => {
    if (!selectedNodeId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeSelectedNode();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [removeSelectedNode, selectedNodeId]);

  const deleteCanvas = useCallback(async (canvasId: string) => {
    try {
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
  }, [authHeaders, canvases, createCanvas, syncCanvasState]);

  const selectCanvas = useCallback((canvas: WorkflowCanvasRecord) => {
    syncCanvasState(canvas);
  }, [syncCanvasState]);

  const runCanvas = useCallback(async (mode: 'node' | 'branch') => {
    if (!activeCanvasId || !selectedNodeId) {
      setError('Select a node to run this workflow.');
      return;
    }

    try {
      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/run`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          startNodeId: selectedNodeId,
          mode,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to run workflow');
      setActiveRunId(data.runId as string);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Failed to run workflow');
    }
  }, [activeCanvasId, authHeaders, selectedNodeId]);

  const uploadAssetToBucket = useCallback(async (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => {
    const { data: { user } } = await supabase.auth.getUser();
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
  }, []);

  const selectedKind = selectedNode?.type;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060606] text-white">
      <div className="flex h-screen">
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
              <button onClick={() => void createCanvas()} className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                New
              </button>
            </div>
            <div className="space-y-2">
              {canvases.map((canvas) => (
                <div
                  key={canvas.id}
                  className={`rounded-2xl border px-3 py-3 ${canvas.id === activeCanvasId ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-white/10 bg-white/[0.03]'}`}
                >
                  <button className="w-full text-left" onClick={() => selectCanvas(canvas)}>
                    <div className="text-sm font-medium text-white">{canvas.title}</div>
                    <div className="text-xs text-zinc-500">{new Date(canvas.updated_at).toLocaleString()}</div>
                  </button>
                  <button onClick={() => void deleteCanvas(canvas.id)} className="mt-2 text-xs text-zinc-500 hover:text-rose-300">
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-white/10 bg-black/40 px-5 py-4">
            <div className="flex items-center gap-4">
              <input
                value={canvasTitle}
                onChange={(event) => {
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
            <div className="flex items-center gap-2">
              <button onClick={() => void persistCanvas()} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 hover:bg-white/[0.06]">
                <Save className="h-4 w-4" /> Save
              </button>
              <button onClick={() => void runCanvas('node')} className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 hover:bg-emerald-500/20">
                <Play className="h-4 w-4" /> Run node
              </button>
              <button onClick={() => void runCanvas('branch')} className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 hover:bg-sky-500/20">
                <ZoomIn className="h-4 w-4" /> Run from here
              </button>
              {selectedNode && (
                <button onClick={removeSelectedNode} className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 hover:bg-rose-500/20">
                  <Trash2 className="h-4 w-4" /> Delete node
                </button>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <section className="relative flex-1">
              {error && (
                <div className="absolute left-4 top-4 z-20 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {error}
                </div>
              )}
              <ReactFlow
                nodes={nodes as never}
                edges={edges as never}
                onNodesChange={onNodesChange as never}
                onEdgesChange={onEdgesChange as never}
                onConnect={handleConnect as never}
                onSelectionChange={({ nodes: selectedNodes }: { nodes: Array<{ id: string }> }) => setSelectedNodeId(selectedNodes[0]?.id || null)}
                onInit={setReactFlowInstance}
                onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
                fitView
                defaultViewport={DEFAULT_VIEWPORT}
                nodeTypes={nodeTypes as never}
                className="bg-[#070707]"
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#27272a" />
                <MiniMap
                  pannable
                  zoomable
                  className="!border !border-white/10 !bg-black/80"
                  nodeColor={() => '#3f3f46'}
                />
                <Controls className="!border !border-white/10 !bg-black/80" />
              </ReactFlow>
            </section>

            <aside className="flex w-[340px] shrink-0 flex-col border-l border-white/10 bg-black/50">
              <div className="border-b border-white/10 px-5 py-4">
                <div className="text-sm font-semibold">Inspector</div>
                <div className="text-xs text-zinc-500">Edit the selected node and configure execution settings.</div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4">
                {!selectedNode && <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-sm text-zinc-500">Select a node on the canvas to edit its content, models, and media.</div>}

                {selectedNode && (
                  <div className="space-y-4">
                    <div>
                      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Title</label>
                      <input
                        value={selectedNode.data.title}
                        onChange={(event) => updateNode(selectedNode.id, { ...selectedNode.data, title: event.target.value })}
                        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
                      />
                    </div>

                    {(selectedKind === 'text-input' || selectedKind === 'note') && (
                      <div>
                        <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Content</label>
                        <textarea
                          rows={8}
                          value={((selectedNode.data as TextInputNodeData | NoteNodeData).text ?? '') as string}
                          onChange={(event) => updateNode(selectedNode.id, { ...selectedNode.data, text: event.target.value } as Partial<WorkflowNodeData>)}
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
                              const uploaded = await uploadAssetToBucket(file, 'generated_images');
                              updateNode(selectedNode.id, {
                                ...selectedNode.data,
                                imageUrl: uploaded.signedUrl,
                                storagePath: uploaded.storagePath,
                              } as Partial<WorkflowNodeData>);
                            } catch (uploadError) {
                              setError(uploadError instanceof Error ? uploadError.message : 'Image upload failed');
                            }
                          }}
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm"
                        />
                        {(selectedNode.data as ImageInputNodeData).imageUrl && <img src={(selectedNode.data as ImageInputNodeData).imageUrl || ''} alt="" className="w-full rounded-2xl border border-white/10" />}
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
                              const uploaded = await uploadAssetToBucket(file, 'generated_videos');
                              updateNode(selectedNode.id, {
                                ...selectedNode.data,
                                videoUrl: uploaded.signedUrl,
                                storagePath: uploaded.storagePath,
                              } as Partial<WorkflowNodeData>);
                            } catch (uploadError) {
                              setError(uploadError instanceof Error ? uploadError.message : 'Video upload failed');
                            }
                          }}
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm"
                        />
                        {(selectedNode.data as VideoInputNodeData).videoUrl && <video src={(selectedNode.data as VideoInputNodeData).videoUrl || ''} className="w-full rounded-2xl border border-white/10" controls muted playsInline />}
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
                              const uploaded = await uploadAssetToBucket(file, 'generated_audio');
                              updateNode(selectedNode.id, {
                                ...selectedNode.data,
                                audioUrl: uploaded.signedUrl,
                                storagePath: uploaded.storagePath,
                              } as Partial<WorkflowNodeData>);
                            } catch (uploadError) {
                              setError(uploadError instanceof Error ? uploadError.message : 'Audio upload failed');
                            }
                          }}
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-sm"
                        />
                        {(selectedNode.data as AudioInputNodeData).audioUrl && <audio src={(selectedNode.data as AudioInputNodeData).audioUrl || ''} className="w-full rounded-2xl border border-white/10" controls />}
                      </div>
                    )}

                    {selectedKind === 'image-generate' && (
                      <>
                        <SelectField
                          label="Model"
                          value={(selectedNode.data as WorkflowNodeData & { model: string }).model}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, model: value } as Partial<WorkflowNodeData>)}
                          options={['nano-banana-2', 'nano-banana-pro']}
                        />
                        <SelectField
                          label="Aspect ratio"
                          value={(selectedNode.data as WorkflowNodeData & { aspectRatio: string }).aspectRatio}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, aspectRatio: value } as Partial<WorkflowNodeData>)}
                          options={['auto', '1:1', '9:16', '16:9', '4:5']}
                        />
                        <SelectField
                          label="Resolution"
                          value={(selectedNode.data as WorkflowNodeData & { resolution: string }).resolution}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, resolution: value } as Partial<WorkflowNodeData>)}
                          options={['1K', '2K', '4K']}
                        />
                      </>
                    )}

                    {selectedKind === 'video-generate' && (
                      <>
                        <SelectField
                          label="Model"
                          value={(selectedNode.data as VideoGenerateNodeData).model}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, model: value } as Partial<WorkflowNodeData>)}
                          options={['kling-3.0-video', 'seedance-1.5-pro', 'veo-3.1']}
                        />
                        <SelectField
                          label="Aspect ratio"
                          value={(selectedNode.data as VideoGenerateNodeData).aspectRatio}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, aspectRatio: value } as Partial<WorkflowNodeData>)}
                          options={['9:16', '16:9', '1:1']}
                        />
                        <NumberField
                          label="Duration"
                          value={(selectedNode.data as VideoGenerateNodeData).duration}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, duration: value } as Partial<WorkflowNodeData>)}
                        />
                        <SelectField
                          label="Mode"
                          value={(selectedNode.data as VideoGenerateNodeData).mode}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, mode: value } as Partial<WorkflowNodeData>)}
                          options={['std', 'pro', 'veo3_fast', 'veo3']}
                        />
                        <CheckboxField
                          label="Native audio"
                          checked={(selectedNode.data as VideoGenerateNodeData).sound}
                          onChange={(checked) => updateNode(selectedNode.id, { ...selectedNode.data, sound: checked } as Partial<WorkflowNodeData>)}
                        />
                      </>
                    )}

                    {selectedKind === 'motion-generate' && (
                      <>
                        <SelectField
                          label="Model"
                          value={(selectedNode.data as WorkflowNodeData & { model: string }).model}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, model: value } as Partial<WorkflowNodeData>)}
                          options={['kling-2.6', 'kling-3.0']}
                        />
                        <SelectField
                          label="Resolution"
                          value={(selectedNode.data as WorkflowNodeData & { mode: string }).mode}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, mode: value } as Partial<WorkflowNodeData>)}
                          options={['720p', '1080p']}
                        />
                        <SelectField
                          label="Character orientation"
                          value={(selectedNode.data as WorkflowNodeData & { characterOrientation: string }).characterOrientation}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, characterOrientation: value } as Partial<WorkflowNodeData>)}
                          options={['video', 'image']}
                        />
                      </>
                    )}

                    {selectedKind === 'voiceover-generate' && (
                      <>
                        <SelectField
                          label="Model"
                          value={(selectedNode.data as VoiceoverGenerateNodeData).model}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, model: value } as Partial<WorkflowNodeData>)}
                          options={[...VOICEOVER_MODEL_OPTIONS]}
                        />
                        <TextField
                          label="Language code"
                          value={(selectedNode.data as VoiceoverGenerateNodeData).languageCode}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, languageCode: value } as Partial<WorkflowNodeData>)}
                        />
                        <NumberField
                          label="Stability"
                          value={(selectedNode.data as VoiceoverGenerateNodeData).stability}
                          min={0}
                          max={1}
                          step={0.1}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, stability: value } as Partial<WorkflowNodeData>)}
                        />

                        {(selectedNode.data as VoiceoverGenerateNodeData).model === 'text-to-dialogue-v3' ? (
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
                                    const current = (selectedNode.data as VoiceoverGenerateNodeData).dialogueTurns;
                                    const nextTurn: DialogueTurn = {
                                      id: `turn-${crypto.randomUUID()}`,
                                      voice: `Speaker ${current.length + 1}`,
                                      text: '',
                                    };
                                    updateNode(selectedNode.id, {
                                      ...selectedNode.data,
                                      dialogueTurns: [...current, nextTurn],
                                    } as Partial<WorkflowNodeData>);
                                  }}
                                  className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-zinc-200 hover:bg-white/[0.08]"
                                >
                                  Add turn
                                </button>
                              </div>
                              {(selectedNode.data as VoiceoverGenerateNodeData).dialogueTurns.map((turn, index) => (
                                <div key={turn.id} className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                                  <div className="flex items-center justify-between">
                                    <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Turn {index + 1}</div>
                                    {(selectedNode.data as VoiceoverGenerateNodeData).dialogueTurns.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => updateNode(selectedNode.id, {
                                          ...selectedNode.data,
                                          dialogueTurns: (selectedNode.data as VoiceoverGenerateNodeData).dialogueTurns.filter((candidate) => candidate.id !== turn.id),
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
                                    onChange={(value) => updateNode(selectedNode.id, {
                                      ...selectedNode.data,
                                      dialogueTurns: (selectedNode.data as VoiceoverGenerateNodeData).dialogueTurns.map((candidate) =>
                                        candidate.id === turn.id ? { ...candidate, voice: value } : candidate
                                      ),
                                    } as Partial<WorkflowNodeData>)}
                                  />
                                  <TextAreaField
                                    label="Dialogue text"
                                    value={turn.text}
                                    onChange={(value) => updateNode(selectedNode.id, {
                                      ...selectedNode.data,
                                      dialogueTurns: (selectedNode.data as VoiceoverGenerateNodeData).dialogueTurns.map((candidate) =>
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
                              value={(selectedNode.data as VoiceoverGenerateNodeData).voice}
                              onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, voice: value } as Partial<WorkflowNodeData>)}
                            />
                            <NumberField
                              label="Similarity boost"
                              value={(selectedNode.data as VoiceoverGenerateNodeData).similarityBoost}
                              min={0}
                              max={1}
                              step={0.1}
                              onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, similarityBoost: value } as Partial<WorkflowNodeData>)}
                            />
                            <NumberField
                              label="Style"
                              value={(selectedNode.data as VoiceoverGenerateNodeData).style}
                              min={0}
                              max={1}
                              step={0.1}
                              onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, style: value } as Partial<WorkflowNodeData>)}
                            />
                            <NumberField
                              label="Speed"
                              value={(selectedNode.data as VoiceoverGenerateNodeData).speed}
                              min={0.5}
                              max={2}
                              step={0.1}
                              onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, speed: value } as Partial<WorkflowNodeData>)}
                            />
                            <CheckboxField
                              label="Return timestamps"
                              checked={(selectedNode.data as VoiceoverGenerateNodeData).timestamps}
                              onChange={(checked) => updateNode(selectedNode.id, { ...selectedNode.data, timestamps: checked } as Partial<WorkflowNodeData>)}
                            />
                          </>
                        )}
                      </>
                    )}

                    {selectedKind === 'music-generate' && (
                      <>
                        <NumberField
                          label="Duration"
                          value={(selectedNode.data as MusicGenerateNodeData).duration}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, duration: value } as Partial<WorkflowNodeData>)}
                        />
                        <TextField
                          label="Mood"
                          value={(selectedNode.data as MusicGenerateNodeData).mood}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, mood: value } as Partial<WorkflowNodeData>)}
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
                          value={(selectedNode.data as SoundEffectsGenerateNodeData).model}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, model: value } as Partial<WorkflowNodeData>)}
                          options={['sound-effect-v2']}
                        />
                        <NumberField
                          label="Duration"
                          value={(selectedNode.data as SoundEffectsGenerateNodeData).duration}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, duration: value } as Partial<WorkflowNodeData>)}
                        />
                        <CheckboxField
                          label="Loop"
                          checked={(selectedNode.data as SoundEffectsGenerateNodeData).loop}
                          onChange={(checked) => updateNode(selectedNode.id, { ...selectedNode.data, loop: checked } as Partial<WorkflowNodeData>)}
                        />
                        <NumberField
                          label="Prompt influence"
                          value={(selectedNode.data as SoundEffectsGenerateNodeData).promptInfluence}
                          min={0}
                          max={1}
                          step={0.1}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, promptInfluence: value } as Partial<WorkflowNodeData>)}
                        />
                        <SelectField
                          label="Output format"
                          value={(selectedNode.data as SoundEffectsGenerateNodeData).outputFormat}
                          onChange={(value) => updateNode(selectedNode.id, { ...selectedNode.data, outputFormat: value } as Partial<WorkflowNodeData>)}
                          options={['mp3', 'wav']}
                        />
                      </>
                    )}

                    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                      <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Latest run</div>
                      <div className="mt-3 space-y-2 text-sm text-zinc-300">
                        <div>Status: {selectedNode.data.runState.status}</div>
                        <div>Generation ID: {selectedNode.data.runState.generationId || 'None yet'}</div>
                        <div>Cost: {selectedNode.data.runState.cost ?? 'N/A'}</div>
                        {selectedNode.data.runState.error && <div className="text-rose-300">{selectedNode.data.runState.error}</div>}
                      </div>
                    </div>

                    <button onClick={removeSelectedNode} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100 hover:bg-rose-500/20">
                      <Trash2 className="h-4 w-4" /> Delete selected node
                    </button>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <input
        type="text"
        value={value}
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <textarea
        value={value}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      >
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
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
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-white/20 bg-transparent"
      />
    </label>
  );
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
