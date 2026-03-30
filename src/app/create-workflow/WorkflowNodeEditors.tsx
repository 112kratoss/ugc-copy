'use client';

import { Copy, Layers3, Trash2, X } from 'lucide-react';
import { getDisplayMediaUrl } from '@/lib/media-urls';
import type {
  AudioInputNodeData,
  DialogueTurn,
  ImageInputNodeData,
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
import type { CanvasFloatingPosition, PreviewMediaState } from './workflowCanvasUiTypes';
import { formatHandleLabel, getNodeLabel, getNodePreviewKind } from './workflowCanvasUiUtils';

const VOICEOVER_MODEL_OPTIONS = [
  'text-to-speech-turbo-2-5',
  'text-to-speech-multilingual-v2',
  'text-to-dialogue-v3',
] as const;

type SelectOption = string | { value: string; label: string };

interface FloatingNodeEditorProps {
  node: WorkflowCanvasNode;
  selectedKind: WorkflowNodeKind | undefined;
  position: CanvasFloatingPosition;
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNodeData>) => void;
  onUploadAsset: (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => Promise<{ signedUrl: string; storagePath: string }>;
  onDeleteNode: () => void;
  onOpenPreview: (preview: PreviewMediaState) => void;
  onClose: () => void;
  onSetError: (message: string | null) => void;
}

interface FloatingEdgeEditorProps {
  edge: WorkflowCanvasEdge;
  nodes: WorkflowCanvasNode[];
  position: CanvasFloatingPosition;
  onDelete: () => void;
  onClose: () => void;
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

export function FloatingEdgeEditor({
  edge,
  nodes,
  position,
  onDelete,
  onClose,
}: FloatingEdgeEditorProps) {
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

export function FloatingNodeEditor({
  node,
  selectedKind,
  position,
  onUpdateNode,
  onUploadAsset,
  onDeleteNode,
  onOpenPreview,
  onClose,
  onSetError,
}: FloatingNodeEditorProps) {
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
