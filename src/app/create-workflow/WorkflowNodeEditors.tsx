'use client';

import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { AlertCircle, Image as ImageIcon, Loader2, Sparkles, Trash2, Upload, Video, Volume2, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import {
  PromptEnhancementError,
  requestPromptEnhancement,
} from '@/app/components/enhancePromptClient';
import {
  getMentionQueryAtCaret,
  insertHandleIntoPrompt,
  isValidElementHandle,
} from '@/lib/image-elements';
import { getDisplayMediaUrl } from '@/lib/media-urls';
import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS, getVideoDurationRange, getVideoElementSupport } from '@/lib/models';
import type { EnhancerContext } from '@/lib/prompt-enhancer';
import type {
  AudioInputNodeData,
  DialogueTurn,
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
  WorkflowCanvasGraph,
  WorkflowCanvasNode,
  WorkflowHandleType,
  WorkflowMultiPrompt,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowPromptMentionCandidate,
  WorkflowPromptEnhancementTarget,
  WorkflowReferenceElement,
  WorkflowResolvedImageReference,
  SeedanceAssetMetadata,
  SeedanceAssetStatus,
} from '@/lib/workflow-canvas';
import {
  getResolvedWorkflowImageReferences,
  getIncomingEdges,
  getNodeById,
  getPromptEnhancementTargets,
  getWorkflowPromptMentionCandidates,
  getWorkflowReferenceElementSourceUrl,
  getWorkflowNodeInputHandles,
  getWorkflowNodeOutputHandles,
  inspectWorkflowNodeCapabilities,
  inspectWorkflowNodeDependencies,
  isSeedance2VideoModel,
  normalizeNodeData,
  resolveNodeInputs,
} from '@/lib/workflow-canvas';
import {
  createSeedanceAssetMetadata,
  getSeedanceAssetStatusLabel,
  type SeedanceAssetKind,
} from '@/lib/seedance-assets';
import type {
  CanvasAnchoredPopupPosition,
  CanvasSelectionState,
  PreviewMediaState,
  WorkflowInspectorPanel,
  WorkflowInspectorTab,
  WorkflowRunAffordance,
} from './workflowCanvasUiTypes';
import { formatHandleLabel, getNodeLabel, getNodePreviewKind } from './workflowCanvasUiUtils';

const VOICEOVER_MODEL_OPTIONS = [
  'text-to-speech-turbo-2-5',
  'text-to-speech-multilingual-v2',
  'text-to-dialogue-v3',
] as const;

type SelectOption = string | { value: string; label: string };

interface WorkflowCanvasInspectorProps {
  activePanel: WorkflowInspectorPanel | null;
  graph: WorkflowCanvasGraph;
  nodePopupPosition: CanvasAnchoredPopupPosition | null;
  nodes: WorkflowCanvasNode[];
  onCreditsUpdate?: (remainingCredits: number | null) => void;
  selectedEdge: WorkflowCanvasEdge | null;
  selectedNode: WorkflowCanvasNode | null;
  runAffordance: WorkflowRunAffordance | null;
  selection: CanvasSelectionState;
  onClearSelection: () => void;
  onDeleteEdge: (edgeId?: string) => void;
  onDeleteNode: () => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onOpenPreview: (preview: PreviewMediaState) => void;
  onRunBranch: () => void;
  onRunNode: () => void;
  onSetError: (message: string | null) => void;
  onPanelChange: (panel: WorkflowInspectorPanel | null) => void;
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNodeData>) => void;
  onUploadAsset: (
    file: File,
    bucket: 'generated_images' | 'generated_videos' | 'generated_audio'
  ) => Promise<{ signedUrl: string; storagePath: string }>;
}

interface NodeEditorContentProps {
  graph: WorkflowCanvasGraph;
  node: WorkflowCanvasNode;
  onCreditsUpdate?: (remainingCredits: number | null) => void;
  onDeleteEdge: (edgeId: string) => void;
  onDeleteNode: () => void;
  onOpenPreview: (preview: PreviewMediaState) => void;
  onSetError: (message: string | null) => void;
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNodeData>) => void;
  onUploadAsset: (
    file: File,
    bucket: 'generated_images' | 'generated_videos' | 'generated_audio'
  ) => Promise<{ signedUrl: string; storagePath: string }>;
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
          return (
            <option key={normalized.value} value={normalized.value}>
              {normalized.label}
            </option>
          );
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

function StaticField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
        {value}
      </div>
    </div>
  );
}

function UploadTile({
  inputId,
  inputLabel,
  accept,
  title,
  description,
  icon,
  accentClassName,
  onSelect,
}: {
  inputId: string;
  inputLabel: string;
  accept: string;
  title: string;
  description: string;
  icon: ReactNode;
  accentClassName: string;
  onSelect: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">{inputLabel}</div>
      <input
        id={inputId}
        type="file"
        accept={accept}
        aria-label={`${inputLabel} file`}
        onChange={onSelect}
        className="sr-only"
      />
      <label
        htmlFor={inputId}
        className="group flex cursor-pointer items-center gap-4 rounded-3xl border border-dashed border-white/10 bg-black/20 px-4 py-4 transition hover:border-white/20 hover:bg-white/[0.04]"
      >
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] transition group-hover:bg-white/[0.08] ${accentClassName}`}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-100">{title}</div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500">{description}</div>
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-300 transition group-hover:border-white/20 group-hover:bg-white/[0.08] group-hover:text-white">
          Browse
        </div>
      </label>
    </div>
  );
}

function getElementPreviewUrl(element: Pick<WorkflowReferenceElement, 'storagePath' | 'url'>): string | null {
  const sourceUrl = getWorkflowReferenceElementSourceUrl(element as WorkflowReferenceElement);
  return sourceUrl ? getDisplayMediaUrl(sourceUrl) : null;
}

function sanitizeWorkflowReferenceHandle(nextValue: string) {
  const normalized = nextValue
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const candidate = normalized ? `@${normalized}` : '';

  if (!candidate) {
    return null;
  }

  if (isValidElementHandle(candidate)) {
    return candidate;
  }

  return null;
}

function ImageReferencesCard({
  title = 'Image references',
  references,
  maxReferences,
  helperText,
  onDeleteEdge,
}: {
  title?: string;
  references: WorkflowResolvedImageReference[];
  maxReferences: number;
  helperText: string;
  onDeleteEdge: (edgeId: string) => void;
}) {
  const hasLegacyBindingHandles = references.some((reference) => reference.handleSource === 'legacy-binding');

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">{title}</div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">{helperText}</p>
        </div>
        <div className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-300">
          {references.length}/{maxReferences}
        </div>
      </div>

      {hasLegacyBindingHandles && (
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-50/90">
          Some connected refs still use legacy target-owned handles. Move those handles onto the source image nodes to fully switch to source-owned references.
        </div>
      )}

      <div className="mt-4 space-y-3">
        {references.length > 0 ? references.map((element) => {
          const previewUrl = getElementPreviewUrl(element);
          return (
            <div key={element.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="flex gap-3">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
                  {previewUrl ? (
                    <img src={previewUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      Missing
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="text-xs text-zinc-400">
                    Source: <span className="text-zinc-200">{element.sourceTitle}</span>
                    {!element.url && <span className="ml-2 text-amber-300">Output pending</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {element.handle ? (
                      <>
                        <span className="rounded-full border border-fuchsia-500/20 bg-fuchsia-500/10 px-2 py-1 text-[11px] font-medium text-fuchsia-100">
                          {element.handle}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-400">
                          {element.handleSource === 'legacy-binding' ? 'Legacy target handle' : 'Source handle'}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                              void navigator.clipboard.writeText(element.handle!);
                            }
                          }}
                          className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
                        >
                          Copy handle
                        </button>
                      </>
                    ) : (
                      <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-400">
                        Anonymous reference
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteEdge(element.edgeId)}
                      className="rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-100 hover:bg-rose-500/20"
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        }) : (
          <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-3 py-3 text-sm text-zinc-500">
            Connect an image output to the node’s <span className="font-medium text-white">Image reference</span> handle to use it here.
          </div>
        )}
      </div>
    </div>
  );
}

function VideoFramesCard({
  startFrameLabel,
  endFrameLabel,
  isMultiShot,
}: {
  startFrameLabel: string | null;
  endFrameLabel: string | null;
  isMultiShot: boolean;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div>
        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Frames</div>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          {isMultiShot
            ? 'Connect one image to Start frame when you want the first shot anchored. End frame stays disabled in multi-shot.'
            : 'Connect one image to Start frame, then connect another image to End frame when you want the video to transition toward a second target frame.'}
        </p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Start frame</div>
          <div className="mt-2 text-sm text-zinc-100">{startFrameLabel || 'Not connected'}</div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">End frame</div>
          <div className="mt-2 text-sm text-zinc-100">
            {isMultiShot ? 'Unavailable in multi-shot' : (endFrameLabel || 'Optional')}
          </div>
        </div>
      </div>
    </div>
  );
}

function SeedanceAssetStatusCard({
  title,
  asset,
  sourceUrl,
  onError,
  onChange,
}: {
  title: string;
  asset: SeedanceAssetMetadata;
  sourceUrl: string | null;
  onError: (message: string) => void;
  onChange: (asset: SeedanceAssetMetadata) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);

  const requestSeedanceAsset = async (assetType: SeedanceAssetKind, assetId?: string | null) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Please log in to prepare Seedance assets.');
    }

    const response = assetId
      ? await fetch(`/api/seedance-assets?assetId=${encodeURIComponent(assetId)}`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        })
      : await fetch('/api/seedance-assets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            url: sourceUrl,
            assetType,
          }),
        });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Seedance asset request failed');
    }

    return createSeedanceAssetMetadata({
      assetId: typeof data.assetId === 'string' ? data.assetId : null,
      assetType,
      status: data.status,
      sourceUrl: typeof data.sourceUrl === 'string' ? data.sourceUrl : sourceUrl,
      error: typeof data.error === 'string' ? data.error : null,
      lastCheckedAt: typeof data.lastCheckedAt === 'string' ? data.lastCheckedAt : new Date().toISOString(),
    });
  };

  const handlePrepare = async () => {
    if (!asset.assetType) {
      onError('Upload media first so Seedance knows which asset type to prepare.');
      return;
    }

    if (!sourceUrl) {
      onError('Upload media first so Seedance has a source URL to prepare.');
      return;
    }

    setIsLoading(true);
    try {
      onChange(await requestSeedanceAsset(asset.assetType));
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Failed to prepare Seedance asset');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!asset.assetType || !asset.assetId) {
      return;
    }

    setIsLoading(true);
    try {
      onChange(await requestSeedanceAsset(asset.assetType, asset.assetId));
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Failed to refresh Seedance asset');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">{title}</div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Track whether this uploaded source has already been prepared for Seedance 2 references.
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-300">
          {getSeedanceAssetStatusLabel(asset.status)}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handlePrepare()}
          disabled={isLoading || !sourceUrl}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {asset.assetId ? 'Retry prep' : 'Prepare asset'}
        </button>
        {asset.assetId ? (
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh status
          </button>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <StaticField
          label="Asset status"
          value={getSeedanceAssetStatusLabel(asset.status)}
        />
        <StaticField
          label="Asset ID"
          value={asset.assetId || 'Not prepared yet'}
        />
        <StaticField
          label="Asset type"
          value={asset.assetType || 'Unassigned'}
        />
        <StaticField
          label="Source URL"
          value={sourceUrl || asset.sourceUrl || 'Not captured yet'}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <StaticField
          label="Error"
          value={asset.error || 'No provider error'}
        />
        <StaticField
          label="Last checked"
          value={asset.lastCheckedAt || 'Never'}
        />
      </div>
    </div>
  );
}

function SourceReferenceHandleField({
  value,
  helperText,
  onChange,
}: {
  value: string | null | undefined;
  helperText: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Reference handle</div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">{helperText}</p>
        </div>
        {value ? (
          <span className="rounded-full border border-fuchsia-500/20 bg-fuchsia-500/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-fuchsia-100">
            Active
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          aria-label="Reference handle"
          value={value || ''}
          placeholder="Optional @handle"
          onChange={(event) => onChange(sanitizeWorkflowReferenceHandle(event.target.value))}
          className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-emerald-500/40"
        />
        {value ? (
          <button
            type="button"
            onClick={() => {
              if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(value);
              }
            }}
            className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.08]"
          >
            Copy handle
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WorkflowPromptField({
  value,
  onChange,
  candidates,
}: {
  value: string;
  onChange: (value: string) => void;
  candidates: WorkflowPromptMentionCandidate[];
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeMentionQuery, setActiveMentionQuery] = useState<{
    query: string;
    replaceStart: number;
    replaceEnd: number;
  } | null>(null);

  const updateMentionState = (nextValue: string, caretIndex?: number) => {
    const fallbackCaret = typeof caretIndex === 'number'
      ? caretIndex
      : (textareaRef.current?.selectionStart ?? nextValue.length);
    setActiveMentionQuery(getMentionQueryAtCaret(nextValue, fallbackCaret));
  };

  const handlePromptChange = (nextValue: string, caretIndex?: number) => {
    onChange(nextValue);
    updateMentionState(nextValue, caretIndex);
  };

  const syncPromptCaretState = () => {
    updateMentionState(value);
  };

  const mentionSuggestions = activeMentionQuery
    ? candidates.filter((candidate) => {
        const normalizedQuery = activeMentionQuery.query.toLowerCase();
        if (!normalizedQuery) {
          return true;
        }

        return (
          candidate.handle.toLowerCase().includes(`@${normalizedQuery}`)
          || candidate.displayName.toLowerCase().includes(normalizedQuery)
          || candidate.branchLabels.some((branchLabel) => branchLabel.toLowerCase().includes(normalizedQuery))
        );
      })
    : [];
  const showMentionSuggestions = Boolean(activeMentionQuery && candidates.length > 0);

  const handleInsertMention = (handle: string) => {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? value.length;
    const selectionEnd = textarea?.selectionEnd ?? value.length;
    const nextValue = insertHandleIntoPrompt(
      value,
      handle,
      selectionStart,
      selectionEnd,
      activeMentionQuery
    );

    onChange(nextValue.prompt);
    setActiveMentionQuery(null);

    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextValue.caretIndex, nextValue.caretIndex);
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <label className="text-xs uppercase tracking-[0.18em] text-zinc-500">Prompt</label>
        <p className="max-w-xs text-right text-[11px] leading-relaxed text-zinc-500">
          Type <span className="font-semibold text-zinc-300">@</span> to insert handled image references from connected generator branches.
        </p>
      </div>
      <textarea
        ref={textareaRef}
        aria-label="Prompt"
        rows={8}
        value={value}
        onChange={(event) => handlePromptChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onClick={syncPromptCaretState}
        onKeyUp={syncPromptCaretState}
        className="mt-2 w-full rounded-3xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
      {showMentionSuggestions ? (
        <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Insert reference</div>
              <p className="mt-1 text-sm text-zinc-400">
                {mentionSuggestions.length > 0
                  ? 'Pick a handled reference to insert its @mention.'
                  : 'No matching handled references yet.'}
              </p>
            </div>
            {activeMentionQuery?.query ? (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-zinc-300">
                @{activeMentionQuery.query}
              </span>
            ) : null}
          </div>
          {mentionSuggestions.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              {mentionSuggestions.map((candidate) => (
                <button
                  key={candidate.handle}
                  type="button"
                  aria-label={`Insert ${candidate.handle}`}
                  onClick={() => handleInsertMention(candidate.handle)}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-left transition hover:bg-white/[0.08]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-emerald-200">{candidate.handle}</span>
                        <span className="text-xs text-zinc-500">{candidate.displayName}</span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                        {candidate.branchLabels.join(' • ')}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-white/10 bg-black/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
                      {candidate.sourceCount} branch{candidate.sourceCount === 1 ? '' : 'es'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LegacyHandledReferencesCard({
  elements,
}: {
  elements: WorkflowReferenceElement[];
}) {
  if (elements.length === 0) {
    return null;
  }

  return (
    <div className="rounded-3xl border border-amber-500/20 bg-amber-500/10 p-4">
      <div className="text-xs uppercase tracking-[0.18em] text-amber-200">Legacy handled references</div>
      <p className="mt-2 text-sm leading-relaxed text-amber-50/90">
        This workflow still has older node-local handled references. They remain runnable for compatibility, but new workflow editing should use connected image references from the graph instead.
      </p>
      <div className="mt-4 space-y-3">
        {elements.map((element) => {
          const previewUrl = getElementPreviewUrl(element);
          return (
            <div key={element.id} className="rounded-2xl border border-amber-400/20 bg-black/20 p-3">
              <div className="flex gap-3">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
                  {previewUrl ? (
                    <img src={previewUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                      Missing
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white">{element.displayName}</div>
                  <div className="mt-1 text-xs text-amber-100">{element.handle}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MultiShotEditor({
  shots,
  onChange,
  onCreditsUpdate,
  selectedModel,
  modelId,
  mode,
  aspectRatio,
  sound,
  fixedLens,
  hasStartImage,
  hasEndImage,
}: {
  shots: WorkflowMultiPrompt[];
  onChange: (nextShots: WorkflowMultiPrompt[]) => void;
  onCreditsUpdate?: (remainingCredits: number | null) => void;
  selectedModel: string;
  modelId: string;
  mode: string;
  aspectRatio: string;
  sound: boolean;
  fixedLens: boolean;
  hasStartImage: boolean;
  hasEndImage: boolean;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Shot prompts</div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Multi-shot owns its prompts locally. Each shot can be enhanced on its own before the full run.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange([...shots, { id: `shot-${crypto.randomUUID()}`, prompt: '', duration: 5 }])}
          className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.08]"
        >
          Add shot
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {shots.map((shot, index) => (
          <div key={shot.id} className="rounded-2xl border border-purple-500/20 bg-black/20 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-xs uppercase tracking-[0.18em] text-purple-300">Shot {index + 1}</div>
              {shots.length > 1 && (
                <button
                  type="button"
                  onClick={() => onChange(shots.filter((candidate) => candidate.id !== shot.id))}
                  className="rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-100 hover:bg-rose-500/20"
                >
                  Remove
                </button>
              )}
            </div>
            <EnhancePromptButton
              prompt={shot.prompt}
              onEnhanced={(enhancedPrompt) => onChange(
                shots.map((candidate) => (
                  candidate.id === shot.id
                    ? { ...candidate, prompt: enhancedPrompt }
                    : candidate
                ))
              )}
              onCreditsUpdate={(remainingCredits) => onCreditsUpdate?.(remainingCredits)}
              medium="video"
              selectedModel={selectedModel}
              context={{
                modelId,
                mode,
                aspectRatio,
                duration: shot.duration,
                sound,
                fixedLens,
                shotIndex: index,
                shotCount: shots.length,
                isMultiShot: true,
                hasStartImage,
                hasEndImage,
              }}
              helperText="Polishes this shot only."
              disabled={false}
            />
            <TextAreaField
              label="Shot prompt"
              value={shot.prompt}
              onChange={(value) => onChange(
                shots.map((candidate) => (
                  candidate.id === shot.id
                    ? { ...candidate, prompt: value }
                    : candidate
                ))
              )}
              rows={4}
            />
            <NumberField
              label="Duration"
              value={shot.duration}
              min={1}
              max={12}
              step={1}
              onChange={(value) => onChange(
                shots.map((candidate) => (
                  candidate.id === shot.id
                    ? { ...candidate, duration: Math.max(1, Math.min(12, Math.round(value))) }
                    : candidate
                ))
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

interface PromptEnhancementTargetOption {
  target: WorkflowPromptEnhancementTarget;
  title: string;
  mediumLabel: 'Image' | 'Video' | 'Motion';
  modelLabel: string;
  accentClassName: string;
}

function countIncomingHandleConnections(
  graph: WorkflowCanvasGraph,
  nodeId: string,
  targetHandle: WorkflowHandleType
) {
  return getIncomingEdges(graph, nodeId).filter((edge) => edge.targetHandle === targetHandle).length;
}

type SeedanceReferenceSummaryItem = {
  edgeId: string;
  mediaType: 'Image' | 'Video' | 'Audio';
  sourceTitle: string;
  status: SeedanceAssetStatus;
  assetId: string | null;
  sourceUrl: string | null;
  prepared: boolean;
};

function getSeedanceAssetSummaryItems(
  graph: WorkflowCanvasGraph,
  nodeId: string
): SeedanceReferenceSummaryItem[] {
  return getIncomingEdges(graph, nodeId)
    .filter((edge) => edge.sourceHandle === 'image' || edge.sourceHandle === 'video' || edge.sourceHandle === 'audio')
    .map((edge) => {
      const source = getNodeById(graph, edge.source);
      if (!source) {
        return null;
      }

      const sourceData = source.data as Partial<WorkflowNodeData> & {
        seedanceAsset?: SeedanceAssetMetadata;
        runState?: { status?: string; outputUrl?: string | null };
      };
      const asset = sourceData.seedanceAsset ?? null;
      const outputUrl = getDisplayMediaUrl(
        source.type === 'image-input'
          ? (source.data as ImageInputNodeData).storagePath || (source.data as ImageInputNodeData).imageUrl || ''
          : source.type === 'video-input'
            ? (source.data as VideoInputNodeData).storagePath || (source.data as VideoInputNodeData).videoUrl || ''
            : source.type === 'audio-input'
              ? (source.data as AudioInputNodeData).storagePath || (source.data as AudioInputNodeData).audioUrl || ''
              : sourceData.runState?.outputUrl || ''
      ) || null;

      const sourceTitle = source.data.title || source.id;
      const mediaType = source.type === 'image-input'
        ? 'Image'
        : source.type === 'video-input'
          ? 'Video'
          : source.type === 'audio-input'
            ? 'Audio'
            : edge.sourceHandle === 'video'
              ? 'Video'
              : edge.sourceHandle === 'audio'
                ? 'Audio'
                : 'Image';

      const status = asset?.status ?? (sourceData.runState?.status === 'succeeded' ? 'active' : 'idle');
      const assetId = asset?.assetId ?? null;

      return {
        edgeId: edge.id,
        mediaType,
        sourceTitle,
        status,
        assetId,
        sourceUrl: asset?.sourceUrl ?? outputUrl,
        prepared: status === 'active' && Boolean(assetId),
      } satisfies SeedanceReferenceSummaryItem;
    })
    .filter((item): item is SeedanceReferenceSummaryItem => Boolean(item));
}

function getPromptEnhancementTargetOption(
  graph: WorkflowCanvasGraph,
  target: WorkflowPromptEnhancementTarget
): PromptEnhancementTargetOption | null {
  const node = getNodeById(graph, target.nodeId);
  if (!node) {
    return null;
  }

  if (target.nodeType === 'image-generate') {
    const data = normalizeNodeData('image-generate', node.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData;
    return {
      target,
      title: data.title,
      mediumLabel: 'Image',
      modelLabel: IMAGE_MODELS[data.model].displayName,
      accentClassName: 'border-blue-500/20 bg-blue-500/10 text-blue-100',
    };
  }

  if (target.nodeType === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    return {
      target,
      title: data.title,
      mediumLabel: 'Video',
      modelLabel: VIDEO_MODELS[data.model].displayName,
      accentClassName: 'border-rose-500/20 bg-rose-500/10 text-rose-100',
    };
  }

  const data = normalizeNodeData('motion-generate', node.data as Partial<WorkflowNodeData>) as MotionGenerateNodeData;
  return {
    target,
    title: data.title,
    mediumLabel: 'Motion',
    modelLabel: MOTION_MODELS[data.model].displayName,
    accentClassName: 'border-violet-500/20 bg-violet-500/10 text-violet-100',
  };
}

function buildPromptEnhancementRequest(
  graph: WorkflowCanvasGraph,
  target: WorkflowPromptEnhancementTarget
): { medium: 'image' | 'video' | 'motion'; selectedModel: string; context: EnhancerContext } | null {
  const node = getNodeById(graph, target.nodeId);
  if (!node) {
    return null;
  }

  const resolvedInputs = resolveNodeInputs(graph, node.id);
  const referenceImageCount = resolvedInputs.imageReferences.length;
  const legacyStartFrameConnectionCount = countIncomingHandleConnections(graph, node.id, 'reference-image');
  const startFrameConnectionCount = countIncomingHandleConnections(graph, node.id, 'start-frame') + legacyStartFrameConnectionCount;
  const endFrameConnectionCount = countIncomingHandleConnections(graph, node.id, 'end-frame');
  const hasStartImage = startFrameConnectionCount > 0 || Boolean(resolvedInputs.startFrameUrl);
  const hasEndImage = endFrameConnectionCount > 0 || Boolean(resolvedInputs.endFrameUrl);
  const hasReferenceVideo = countIncomingHandleConnections(graph, node.id, 'reference-video') > 0
    || resolvedInputs.videoUrls.length > 0;
  const resolvedImageReferences = getResolvedWorkflowImageReferences(graph, node.id);
  const handledImageReferences = resolvedImageReferences.filter((reference) => Boolean(reference.handle));
  const elementReferences = handledImageReferences.map((element) => ({
    handle: element.handle!,
    displayName: element.displayName,
  }));

  if (target.nodeType === 'image-generate') {
    const data = normalizeNodeData('image-generate', node.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData;
    return {
      medium: 'image',
      selectedModel: data.model,
      context: {
        modelId: data.model,
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        googleSearch: data.googleSearch,
        referenceImageCount: referenceImageCount + data.elements.length,
        elementEnhancementMode: handledImageReferences.length > 0 ? 'append-only' : undefined,
        elementReferences: handledImageReferences.length > 0 ? elementReferences : undefined,
      },
    };
  }

  if (target.nodeType === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    return {
      medium: 'video',
      selectedModel: VIDEO_MODELS[data.model].enhancerModelId,
      context: {
        modelId: data.model,
        aspectRatio: data.aspectRatio,
        duration: data.duration,
        mode: data.mode || undefined,
        sound: data.sound,
        fixedLens: data.fixedLens,
        resolution: data.resolution || undefined,
        isMultiShot: data.isMultiShot,
        shotCount: data.isMultiShot ? data.multiPrompts.length : undefined,
        hasStartImage,
        hasEndImage,
        referenceImageCount: referenceImageCount > 0
          ? referenceImageCount + data.elements.length
          : startFrameConnectionCount + endFrameConnectionCount,
        elementEnhancementMode: handledImageReferences.length > 0 ? 'append-only' : undefined,
        elementReferences: handledImageReferences.length > 0 ? elementReferences : undefined,
      },
    };
  }

  const data = normalizeNodeData('motion-generate', node.data as Partial<WorkflowNodeData>) as MotionGenerateNodeData;
  return {
    medium: 'motion',
    selectedModel: data.model,
    context: {
      modelId: data.model,
      mode: data.mode,
      characterOrientation: data.characterOrientation,
      referenceImageCount,
      hasReferenceVideo,
    },
  };
}

function getPromptEnhancementHelperText(
  prompt: string,
  targets: PromptEnhancementTargetOption[]
) {
  if (!prompt.trim()) {
    return 'Add prompt text first, then enhance it for a connected image, video, or motion branch.';
  }

  if (targets.length === 0) {
    return 'Prompt enhancement works when this prompt feeds an image, video, or motion generator.';
  }

  if (targets.length === 1) {
    return `Optimizes this prompt for ${targets[0].mediumLabel.toLowerCase()} generation using ${targets[0].modelLabel}.`;
  }

  return 'Choose which connected media branch to optimize for before rewriting this shared prompt.';
}

function PromptNodeEnhancer({
  graph,
  node,
  onCreditsUpdate,
  onUpdateNode,
}: {
  graph: WorkflowCanvasGraph;
  node: WorkflowCanvasNode;
  onCreditsUpdate?: (remainingCredits: number | null) => void;
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNodeData>) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isTargetPickerOpen, setIsTargetPickerOpen] = useState(false);
  const prompt = (node.data as TextInputNodeData).text ?? '';
  const targetOptions = getPromptEnhancementTargets(graph, node.id)
    .map((target) => getPromptEnhancementTargetOption(graph, target))
    .filter((target): target is PromptEnhancementTargetOption => Boolean(target));
  const canEnhance = prompt.trim().length > 0 && targetOptions.length > 0 && !isEnhancing;

  const handleEnhance = async (target: PromptEnhancementTargetOption) => {
    if (isEnhancing) {
      return;
    }

    const request = buildPromptEnhancementRequest(graph, target.target);
    if (!request) {
      setError('That branch is no longer available. Try selecting the node again.');
      return;
    }

    setIsEnhancing(true);
    setError(null);
    setIsTargetPickerOpen(false);

    try {
      const result = await requestPromptEnhancement({
        medium: request.medium,
        selectedModel: request.selectedModel,
        prompt,
        context: request.context,
      });

      onUpdateNode(node.id, {
        ...node.data,
        text: result.enhancedPrompt,
      } as Partial<WorkflowNodeData>);

      if (result.remainingCredits !== undefined) {
        onCreditsUpdate?.(result.remainingCredits);
      }
    } catch (enhanceError) {
      console.error('Workflow prompt enhancement error:', enhanceError);
      if (enhanceError instanceof PromptEnhancementError) {
        if (enhanceError.remainingCredits !== undefined) {
          onCreditsUpdate?.(enhanceError.remainingCredits);
        }
        setError(enhanceError.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setIsEnhancing(false);
    }
  };

  const handlePrimaryAction = () => {
    if (!canEnhance) {
      return;
    }

    if (targetOptions.length === 1) {
      void handleEnhance(targetOptions[0]);
      return;
    }

    setIsTargetPickerOpen((current) => !current);
  };

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Prompt enhancement</div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            {getPromptEnhancementHelperText(prompt, targetOptions)}
          </p>
        </div>
        <button
          type="button"
          aria-label="Enhance prompt"
          onClick={handlePrimaryAction}
          disabled={!canEnhance}
          className={`group inline-flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-xs font-semibold transition ${
            canEnhance
              ? 'border-violet-500/30 bg-gradient-to-r from-violet-600/20 to-blue-600/20 text-violet-200 hover:from-violet-600/30 hover:to-blue-600/30'
              : 'cursor-not-allowed border-white/5 bg-zinc-900/30 text-zinc-600'
          }`}
        >
          {isEnhancing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className={`h-3.5 w-3.5 transition ${canEnhance ? 'group-hover:scale-110' : ''}`} />
          )}
          <span>{isEnhancing ? 'Enhancing...' : 'Enhance'}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
            canEnhance ? 'bg-violet-500/20 text-violet-300' : 'bg-zinc-800 text-zinc-600'
          }`}>
            2 credits
          </span>
        </button>
      </div>

      {isTargetPickerOpen && targetOptions.length > 1 && (
        <div className="mt-4 space-y-2">
          <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Choose target branch</div>
          {targetOptions.map((target) => (
            <button
              key={target.target.nodeId}
              type="button"
              aria-label={`Enhance prompt for ${target.title}`}
              onClick={() => {
                void handleEnhance(target);
              }}
              disabled={isEnhancing}
              className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-white">{target.title}</div>
                <div className="mt-1 text-xs text-zinc-400">{target.modelLabel}</div>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.16em] ${target.accentClassName}`}>
                {target.mediumLabel}
              </span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function getInspectorNodeTypeLabel(nodeType: WorkflowNodeKind): string {
  if (nodeType === 'text-input') {
    return 'Prompt node';
  }

  if (nodeType === 'note') {
    return 'Canvas note';
  }

  return nodeType.replace(/-/g, ' ');
}

function InspectorHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-b border-white/10 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{eyebrow}</div>
          <div className="mt-2 text-base font-semibold text-white">{title}</div>
          <div className="mt-1 text-sm text-zinc-400">{description}</div>
        </div>
        {action}
      </div>
    </div>
  );
}

function EdgeSummaryPanel({
  edge,
  nodes,
  onClearSelection,
  onDeleteEdge,
}: {
  edge: WorkflowCanvasEdge;
  nodes: WorkflowCanvasNode[];
  onClearSelection: () => void;
  onDeleteEdge: (edgeId?: string) => void;
}) {
  return (
    <>
      <InspectorHeader
        eyebrow="Connection"
        title={`${getNodeLabel(nodes, edge.source)} -> ${getNodeLabel(nodes, edge.target)}`}
        description="Connection routing stays docked here so the graph can stay visually calm while you inspect or remove links."
        action={(
          <button
            type="button"
            aria-label="Clear selection"
            onClick={onClearSelection}
            className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      />
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
          <div className="space-y-2 text-sm text-zinc-300">
            <div>From: {getNodeLabel(nodes, edge.source)} ({formatHandleLabel(edge.sourceHandle)})</div>
            <div>To: {getNodeLabel(nodes, edge.target)} ({formatHandleLabel(edge.targetHandle)})</div>
          </div>
          <button
            type="button"
            onClick={() => onDeleteEdge(edge.id)}
            className="inline-flex items-center gap-2 rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
          >
            <Trash2 className="h-4 w-4" /> Delete connection
          </button>
        </div>
      </div>
    </>
  );
}

async function readVideoDurationSeconds(file: File): Promise<number | null> {
  const previewUrl = URL.createObjectURL(file);

  try {
    const durationSeconds = await new Promise<number | null>((resolve) => {
      const previewVideo = document.createElement('video');

      const cleanup = () => {
        previewVideo.removeAttribute('src');
        previewVideo.load();
      };

      previewVideo.preload = 'metadata';
      previewVideo.onloadedmetadata = () => {
        const nextDuration = Number.isFinite(previewVideo.duration) ? previewVideo.duration : null;
        cleanup();
        resolve(nextDuration);
      };
      previewVideo.onerror = () => {
        cleanup();
        resolve(null);
      };
      previewVideo.src = previewUrl;
    });

    return durationSeconds;
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

function formatSecondsLabel(value: number) {
  const rounded = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${rounded}s`;
}

function CapabilityLimitsCard({
  graph,
  node,
}: {
  graph: WorkflowCanvasGraph;
  node: WorkflowCanvasNode;
}) {
  if (
    node.type !== 'image-generate' &&
    node.type !== 'video-generate' &&
    node.type !== 'motion-generate'
  ) {
    return null;
  }

  const capabilityValidation = inspectWorkflowNodeCapabilities(graph, node);
  const rows: Array<{ label: string; value: string }> = [];

  if (node.type === 'image-generate' && capabilityValidation.referenceImageLimit !== null) {
    rows.push({
      label: 'Image refs',
      value: `${capabilityValidation.referenceImageCount}/${capabilityValidation.referenceImageLimit}`,
    });
    rows.push({
      label: 'Handled refs',
      value: `${capabilityValidation.connectedElementCount}/${capabilityValidation.referenceImageCount || 0}`,
    });
    if (capabilityValidation.legacyElementCount > 0) {
      rows.push({
        label: 'Legacy handled refs',
        value: `${capabilityValidation.legacyElementCount}`,
      });
    }
    rows.push({
      label: 'Shared image budget',
      value: `${capabilityValidation.totalReferenceImageCount}/${capabilityValidation.referenceImageLimit}`,
    });
  }

  if (node.type === 'video-generate') {
    const videoData = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    const seedanceFamily = isSeedance2VideoModel(videoData.model);

    rows.push({
      label: seedanceFamily ? 'Image refs' : 'Start frame',
      value: seedanceFamily
        ? `${capabilityValidation.referenceImageCount}/${capabilityValidation.referenceImageLimit ?? capabilityValidation.referenceImageCount}`
        : `${capabilityValidation.startFrameCount}/1`,
    });
    rows.push({
      label: seedanceFamily ? 'Video refs' : 'End frame',
      value: seedanceFamily
        ? `${capabilityValidation.referenceVideoCount}/${capabilityValidation.referenceVideoLimit ?? 3}`
        : capabilityValidation.isMultiShot
          ? `${capabilityValidation.endFrameCount}/0`
          : `${capabilityValidation.endFrameCount}/1`,
    });
    rows.push({
      label: seedanceFamily ? 'Audio refs' : 'Frame status',
      value: seedanceFamily
        ? `${capabilityValidation.referenceAudioCount} connected`
        : capabilityValidation.isMultiShot
          ? (capabilityValidation.startFrameCount > 0 ? 'Start connected' : 'Start optional')
          : capabilityValidation.endFrameCount > 0
            ? 'Start + end connected'
            : capabilityValidation.startFrameCount > 0
              ? 'Start connected'
              : 'No frames yet',
    });
    if (!seedanceFamily && (capabilityValidation.referenceImageCount > 0 || capabilityValidation.legacyElementCount > 0)) {
      rows.push({
        label: 'Legacy image refs',
        value: capabilityValidation.referenceImageLimit !== null
          ? `${capabilityValidation.referenceImageCount}/${capabilityValidation.referenceImageLimit}`
          : `${capabilityValidation.referenceImageCount}`,
      });
      rows.push({
        label: 'Handled refs',
        value: capabilityValidation.referenceImageCount > 0
          ? `${capabilityValidation.connectedElementCount}/${capabilityValidation.referenceImageCount}`
          : `${capabilityValidation.connectedElementCount}`,
      });
    }
    if (capabilityValidation.legacyElementCount > 0) {
      rows.push({
        label: 'Legacy handled refs',
        value: `${capabilityValidation.legacyElementCount}`,
      });
    }
    rows.push({
      label: seedanceFamily ? 'Prepared assets' : 'Shot prompts',
      value: seedanceFamily
        ? `${getSeedanceAssetSummaryItems(graph, node.id).filter((item) => item.prepared).length} ready`
        : capabilityValidation.isMultiShot
          ? `${capabilityValidation.multiPromptCount} active`
          : 'Single-shot',
    });
  }

  if (node.type === 'motion-generate') {
    if (capabilityValidation.referenceImageLimit !== null) {
      rows.push({
        label: 'Reference images',
        value: `${capabilityValidation.referenceImageCount}/${capabilityValidation.referenceImageLimit}`,
      });
    }

    if (capabilityValidation.referenceVideoLimit !== null) {
      rows.push({
        label: 'Reference videos',
        value: `${capabilityValidation.referenceVideoCount}/${capabilityValidation.referenceVideoLimit}`,
      });
    }

    if (capabilityValidation.referenceVideoDurationLimitSeconds !== null) {
      rows.push({
        label: 'Reference video limit',
        value: formatSecondsLabel(capabilityValidation.referenceVideoDurationLimitSeconds),
      });
    }
  }

  const toneClasses = capabilityValidation.isValid
    ? node.type === 'image-generate'
      ? 'border-blue-500/20 bg-blue-500/10'
      : node.type === 'video-generate'
        ? 'border-rose-500/20 bg-rose-500/10'
        : 'border-violet-500/20 bg-violet-500/10'
    : 'border-rose-500/30 bg-rose-500/10';

  return (
    <div className={`rounded-3xl border p-4 ${toneClasses}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Capabilities & Limits</div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-300">
            {node.type === 'image-generate'
              ? 'All connected image references share one model budget. Only refs whose source image nodes have @handles are compiled into the prompt.'
              : node.type === 'video-generate'
                ? (() => {
                    const videoData = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
                    if (isSeedance2VideoModel(videoData.model)) {
                      return 'Seedance 2 uses connected image, video, and audio references. Prepared assets are preferred automatically when available.';
                    }
                    return capabilityValidation.isMultiShot
                      ? 'Multi-shot video keeps prompts locally, allows an optional start frame, and does not use end frames.'
                      : capabilityValidation.activeReferenceMode === 'references'
                        ? 'This video node still has legacy general image references attached. New workflow video authoring uses Start frame and optional End frame instead.'
                        : 'Connect an image to Start frame and optionally another to End frame for a single-shot run.';
                  })()
                : 'Motion control needs one image reference, one video reference, and a reference clip that stays within the model limit.'}
          </p>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">{row.label}</div>
              <div className="mt-2 text-sm text-zinc-100">{row.value}</div>
            </div>
          ))}
        </div>
      )}

      {capabilityValidation.unsupportedFeatureNotes.length > 0 && (
        <div className="mt-4 space-y-2">
          {capabilityValidation.unsupportedFeatureNotes.map((note) => (
            <div
              key={note}
              className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-300"
            >
              {note}
            </div>
          ))}
        </div>
      )}

      {!capabilityValidation.isValid && (
        <div className="mt-4 space-y-2">
          {capabilityValidation.issues.map((issue) => (
            <div
              key={issue.code}
              className="flex items-start gap-2 rounded-2xl border border-rose-500/20 bg-black/20 px-3 py-2 text-sm text-rose-100"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NodeEditorContent({
  graph,
  node,
  onCreditsUpdate,
  onDeleteEdge,
  onDeleteNode,
  onOpenPreview,
  onSetError,
  onUpdateNode,
  onUploadAsset,
}: NodeEditorContentProps) {
  const selectedKind = node.type as WorkflowNodeKind;
  const imageGenerateNode = selectedKind === 'image-generate' ? node.data as ImageGenerateNodeData : null;
  const imageModel = imageGenerateNode ? IMAGE_MODELS[imageGenerateNode.model] : null;
  const videoGenerateNode = selectedKind === 'video-generate' ? node.data as VideoGenerateNodeData : null;
  const videoModel = videoGenerateNode ? VIDEO_MODELS[videoGenerateNode.model] : null;
  const isSeedance2Family = Boolean(videoGenerateNode && isSeedance2VideoModel(videoGenerateNode.model));
  const motionGenerateNode = selectedKind === 'motion-generate' ? node.data as MotionGenerateNodeData : null;
  const motionModel = motionGenerateNode ? MOTION_MODELS[motionGenerateNode.model] : null;
  const videoDurationRange = videoGenerateNode ? getVideoDurationRange(videoGenerateNode.model) : null;
  const hasFixedVideoDuration = Boolean(videoModel && !videoDurationRange && videoModel.durations.length === 1);
  const videoElementSupport = videoGenerateNode
    ? getVideoElementSupport(videoGenerateNode.model, {
        mode: videoGenerateNode.mode,
        isMultiShot: videoGenerateNode.isMultiShot,
      })
    : null;
  const resolvedInputs = resolveNodeInputs(graph, node.id);
  const capabilityValidation = inspectWorkflowNodeCapabilities(graph, node);
  const resolvedImageReferences = getResolvedWorkflowImageReferences(graph, node.id);
  const promptMentionCandidates = selectedKind === 'text-input'
    ? getWorkflowPromptMentionCandidates(graph, node.id)
    : [];
  const connectedImageReferences = resolvedImageReferences.filter((reference) => !reference.legacy);
  const legacyVideoReferencesPresent = selectedKind === 'video-generate' && !isSeedance2Family && (
    connectedImageReferences.length > 0 || (videoGenerateNode?.elements.length || 0) > 0
  );
  const seedanceReferenceSummary = selectedKind === 'video-generate' && isSeedance2Family
    ? getSeedanceAssetSummaryItems(graph, node.id)
    : [];
  const startFrameSourceTitle = selectedKind === 'video-generate'
    ? (() => {
        const edge = getIncomingEdges(graph, node.id).find((candidate) => {
          const source = getNodeById(graph, candidate.source);
          return candidate.sourceHandle === 'image'
            && source
            && (candidate.targetHandle === 'start-frame' || candidate.targetHandle === 'reference-image');
        });
        const source = edge ? getNodeById(graph, edge.source) : null;
        return source?.data?.title || null;
      })()
    : null;
  const endFrameSourceTitle = selectedKind === 'video-generate'
    ? (() => {
        const edge = getIncomingEdges(graph, node.id).find((candidate) => {
          const source = getNodeById(graph, candidate.source);
          return candidate.sourceHandle === 'image' && source && candidate.targetHandle === 'end-frame';
        });
        const source = edge ? getNodeById(graph, edge.source) : null;
        return source?.data?.title || null;
      })()
    : null;

  return (
    <div className="space-y-4 px-5 py-5">
      <div>
        <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Title</label>
        <input
          value={node.data.title}
          onChange={(event) => onUpdateNode(node.id, { ...node.data, title: event.target.value })}
          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
        />
      </div>

      {selectedKind === 'text-input' && (
        <>
          <PromptNodeEnhancer
            graph={graph}
            node={node}
            onCreditsUpdate={onCreditsUpdate}
            onUpdateNode={onUpdateNode}
          />
          <WorkflowPromptField
            value={(node.data as TextInputNodeData).text ?? ''}
            candidates={promptMentionCandidates}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, text: value } as Partial<WorkflowNodeData>)}
          />
        </>
      )}

      {selectedKind === 'note' && (
        <div>
          <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Content</label>
          <textarea
            rows={8}
            value={(node.data as NoteNodeData).text ?? ''}
            onChange={(event) => onUpdateNode(node.id, { ...node.data, text: event.target.value } as Partial<WorkflowNodeData>)}
            className="w-full rounded-3xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
          />
        </div>
      )}

      {selectedKind === 'image-input' && (
        <div className="space-y-3">
          {(() => {
            const imageInput = node.data as ImageInputNodeData;
            return (
              <>
                <SourceReferenceHandleField
                  value={imageInput.referenceHandle}
                  helperText="Optional global @handle for this image source. Any downstream generator connected through Image reference can mention it in the prompt."
                  onChange={(referenceHandle) => onUpdateNode(node.id, { ...node.data, referenceHandle } as Partial<WorkflowNodeData>)}
                />
                <UploadTile
                  inputId={`workflow-image-input-${node.id}`}
                  inputLabel="Upload image"
                  accept="image/*"
                  title="Click to upload image"
                  description="PNG, JPG, WEBP and other supported image files."
                  icon={
                    <div className="relative">
                      <ImageIcon className="h-5 w-5" />
                      <Upload className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-[#050505] p-0.5" />
                    </div>
                  }
                  accentClassName="text-sky-300"
                  onSelect={async (event) => {
                    const input = event.currentTarget;
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const uploaded = await onUploadAsset(file, 'generated_images');
                      onUpdateNode(node.id, {
                        ...node.data,
                        imageUrl: uploaded.signedUrl,
                        storagePath: uploaded.storagePath,
                        seedanceAsset: {
                          ...imageInput.seedanceAsset,
                          assetType: 'Image',
                          sourceUrl: uploaded.signedUrl,
                          status: imageInput.seedanceAsset.status === 'active' ? 'active' : 'idle',
                          lastCheckedAt: new Date().toISOString(),
                        },
                      } as Partial<WorkflowNodeData>);
                    } catch (uploadError) {
                      onSetError(uploadError instanceof Error ? uploadError.message : 'Image upload failed');
                    } finally {
                      input.value = '';
                    }
                  }}
                />
                {imageInput.imageUrl && (
                  <img
                    src={getDisplayMediaUrl(imageInput.storagePath || imageInput.imageUrl || '')}
                    alt=""
                    className="w-full rounded-2xl border border-white/10"
                  />
                )}
                <SeedanceAssetStatusCard
                  title="Seedance asset"
                  asset={imageInput.seedanceAsset}
                  sourceUrl={imageInput.storagePath || imageInput.imageUrl || imageInput.seedanceAsset.sourceUrl}
                  onError={onSetError}
                  onChange={(asset) => onUpdateNode(node.id, { ...node.data, seedanceAsset: asset } as Partial<WorkflowNodeData>)}
                />
              </>
            );
          })()}
        </div>
      )}

      {selectedKind === 'video-input' && (
        <div className="space-y-3">
          {(() => {
            const videoInput = node.data as VideoInputNodeData;
            return (
              <>
                <UploadTile
                  inputId={`workflow-video-input-${node.id}`}
                  inputLabel="Upload video"
                  accept="video/*"
                  title="Click to upload video"
                  description="MP4, MOV and other supported video files."
                  icon={
                    <div className="relative">
                      <Video className="h-5 w-5" />
                      <Upload className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-[#050505] p-0.5" />
                    </div>
                  }
                  accentClassName="text-emerald-300"
                  onSelect={async (event) => {
                    const input = event.currentTarget;
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const durationSeconds = await readVideoDurationSeconds(file);
                      const uploaded = await onUploadAsset(file, 'generated_videos');
                      onUpdateNode(node.id, {
                        ...node.data,
                        videoUrl: uploaded.signedUrl,
                        storagePath: uploaded.storagePath,
                        durationSeconds,
                        seedanceAsset: {
                          ...videoInput.seedanceAsset,
                          assetType: 'Video',
                          sourceUrl: uploaded.signedUrl,
                          status: videoInput.seedanceAsset.status === 'active' ? 'active' : 'idle',
                          lastCheckedAt: new Date().toISOString(),
                        },
                      } as Partial<WorkflowNodeData>);
                    } catch (uploadError) {
                      onSetError(uploadError instanceof Error ? uploadError.message : 'Video upload failed');
                    } finally {
                      input.value = '';
                    }
                  }}
                />
                {typeof videoInput.durationSeconds === 'number' && (
                  <div className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-300">
                    Detected duration: {formatSecondsLabel(videoInput.durationSeconds!)}
                  </div>
                )}
                {videoInput.videoUrl && (
                  <video
                    src={getDisplayMediaUrl(videoInput.storagePath || videoInput.videoUrl || '')}
                    className="w-full rounded-2xl border border-white/10"
                    controls
                    muted
                    playsInline
                  />
                )}
                <SeedanceAssetStatusCard
                  title="Seedance asset"
                  asset={videoInput.seedanceAsset}
                  sourceUrl={videoInput.storagePath || videoInput.videoUrl || videoInput.seedanceAsset.sourceUrl}
                  onError={onSetError}
                  onChange={(asset) => onUpdateNode(node.id, { ...node.data, seedanceAsset: asset } as Partial<WorkflowNodeData>)}
                />
              </>
            );
          })()}
        </div>
      )}

      {selectedKind === 'audio-input' && (
        <div className="space-y-3">
          {(() => {
            const audioInput = node.data as AudioInputNodeData;
            return (
              <>
                <UploadTile
                  inputId={`workflow-audio-input-${node.id}`}
                  inputLabel="Upload audio"
                  accept="audio/*"
                  title="Click to upload audio"
                  description="MP3, WAV and other supported audio files."
                  icon={
                    <div className="relative">
                      <Volume2 className="h-5 w-5" />
                      <Upload className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-[#050505] p-0.5" />
                    </div>
                  }
                  accentClassName="text-violet-300"
                  onSelect={async (event) => {
                    const input = event.currentTarget;
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const uploaded = await onUploadAsset(file, 'generated_audio');
                      onUpdateNode(node.id, {
                        ...node.data,
                        audioUrl: uploaded.signedUrl,
                        storagePath: uploaded.storagePath,
                        seedanceAsset: {
                          ...audioInput.seedanceAsset,
                          assetType: 'Audio',
                          sourceUrl: uploaded.signedUrl,
                          status: audioInput.seedanceAsset.status === 'active' ? 'active' : 'idle',
                          lastCheckedAt: new Date().toISOString(),
                        },
                      } as Partial<WorkflowNodeData>);
                    } catch (uploadError) {
                      onSetError(uploadError instanceof Error ? uploadError.message : 'Audio upload failed');
                    } finally {
                      input.value = '';
                    }
                  }}
                />
                {audioInput.audioUrl && (
                  <audio
                    src={getDisplayMediaUrl(audioInput.storagePath || audioInput.audioUrl || '')}
                    className="w-full rounded-2xl border border-white/10"
                    controls
                  />
                )}
                <SeedanceAssetStatusCard
                  title="Seedance asset"
                  asset={audioInput.seedanceAsset}
                  sourceUrl={audioInput.storagePath || audioInput.audioUrl || audioInput.seedanceAsset.sourceUrl}
                  onError={onSetError}
                  onChange={(asset) => onUpdateNode(node.id, { ...node.data, seedanceAsset: asset } as Partial<WorkflowNodeData>)}
                />
              </>
            );
          })()}
        </div>
      )}

      {selectedKind === 'image-generate' && (
        <>
          <CapabilityLimitsCard graph={graph} node={node} />
          <SelectField
            label="Model"
            value={imageGenerateNode?.model || ''}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
            options={Object.values(IMAGE_MODELS).map((modelOption) => ({
              value: modelOption.id,
              label: modelOption.displayName,
            }))}
          />
          <SelectField
            label="Aspect ratio"
            value={imageGenerateNode?.aspectRatio || ''}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, aspectRatio: value } as Partial<WorkflowNodeData>)}
            options={imageModel ? [...imageModel.aspectRatios] : []}
          />
          <SelectField
            label="Resolution"
            value={imageGenerateNode?.resolution || ''}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, resolution: value } as Partial<WorkflowNodeData>)}
            options={imageModel ? [...imageModel.resolutions] : []}
          />
          <SelectField
            label="Output format"
            value={imageGenerateNode?.outputFormat || ''}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, outputFormat: value } as Partial<WorkflowNodeData>)}
            options={imageModel
              ? imageModel.outputFormats.map((format) => ({ value: format, label: format.toUpperCase() }))
              : []}
          />
          {imageModel?.supportsGoogleSearch && (
            <CheckboxField
              label="Google Search grounding"
              checked={Boolean(imageGenerateNode?.googleSearch)}
              onChange={(checked) => onUpdateNode(node.id, { ...node.data, googleSearch: checked } as Partial<WorkflowNodeData>)}
            />
          )}
          <SourceReferenceHandleField
            value={imageGenerateNode?.referenceHandle}
            helperText="Optional global @handle for this node’s generated image output. Downstream generators can mention it whenever they connect this output as an Image reference."
            onChange={(referenceHandle) => onUpdateNode(node.id, { ...node.data, referenceHandle } as Partial<WorkflowNodeData>)}
          />
          {imageGenerateNode && imageModel && (
            <ImageReferencesCard
              title="Image references"
              references={connectedImageReferences}
              maxReferences={imageModel.maxImages}
              helperText="Connect image inputs or upstream image outputs into the Image reference handle. Handles are now owned by the source image nodes and appear here automatically."
              onDeleteEdge={onDeleteEdge}
            />
          )}
          {imageGenerateNode && imageGenerateNode.elements.length > 0 && (
            <LegacyHandledReferencesCard elements={imageGenerateNode.elements} />
          )}
        </>
      )}

      {selectedKind === 'video-generate' && videoGenerateNode && videoModel && (
        <>
          <CapabilityLimitsCard graph={graph} node={node} />
          <SelectField
            label="Model"
            value={videoGenerateNode.model}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
            options={Object.values(VIDEO_MODELS).map((modelOption) => ({
              value: modelOption.id,
              label: modelOption.displayName,
            }))}
          />
          {(videoModel.supportsMultiShot || videoGenerateNode.isMultiShot) && (
            <CheckboxField
              label="Multi-shot"
              checked={videoGenerateNode.isMultiShot}
              onChange={(checked) => onUpdateNode(node.id, { ...node.data, isMultiShot: checked } as Partial<WorkflowNodeData>)}
            />
          )}
          <SelectField
            label="Aspect ratio"
            value={videoGenerateNode.aspectRatio}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, aspectRatio: value } as Partial<WorkflowNodeData>)}
            options={[...videoModel.aspectRatios]}
          />
          {!videoGenerateNode.isMultiShot && (
            videoDurationRange ? (
              <NumberField
                label="Duration"
                value={videoGenerateNode.duration}
                min={videoDurationRange.min}
                max={videoDurationRange.max}
                step={1}
                onChange={(value) => onUpdateNode(node.id, { ...node.data, duration: value } as Partial<WorkflowNodeData>)}
              />
            ) : hasFixedVideoDuration ? (
              <StaticField
                label="Duration"
                value={`${videoModel.durations[0]} sec fixed`}
              />
            ) : (
              <SelectField
                label="Duration"
                value={String(videoGenerateNode.duration)}
                onChange={(value) => onUpdateNode(node.id, { ...node.data, duration: Number(value) } as Partial<WorkflowNodeData>)}
                options={videoModel.durations.map((durationOption) => ({
                  value: String(durationOption),
                  label: `${durationOption} sec`,
                }))}
              />
            )
          )}
          {videoModel.modeOptions.length > 0 && (
            <SelectField
              label={videoGenerateNode.model === 'veo-3.1' ? 'Model variant' : 'Quality mode'}
              value={videoGenerateNode.mode}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, mode: value } as Partial<WorkflowNodeData>)}
              options={videoModel.modeOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
            />
          )}
          {videoModel.resolutions.length > 0 && (
            <SelectField
              label="Resolution"
              value={videoGenerateNode.resolution}
              onChange={(value) => onUpdateNode(node.id, { ...node.data, resolution: value } as Partial<WorkflowNodeData>)}
              options={[...videoModel.resolutions]}
            />
          )}
          {videoModel.supportsSound && (
            <CheckboxField
              label="Native audio"
              checked={videoGenerateNode.sound}
              onChange={(checked) => onUpdateNode(node.id, { ...node.data, sound: checked } as Partial<WorkflowNodeData>)}
            />
          )}
          {videoModel.supportsFixedLens && (
            <CheckboxField
              label="Fixed lens"
              checked={videoGenerateNode.fixedLens}
              onChange={(checked) => onUpdateNode(node.id, { ...node.data, fixedLens: checked } as Partial<WorkflowNodeData>)}
            />
          )}
          {isSeedance2Family ? (
            <>
              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Seedance references</div>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                  Seedance 2 and Seedance 2 Fast run on connected image, video, and audio references. Prepared assets are preferred automatically when the source nodes have an active Seedance asset id.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Image refs</div>
                    <div className="mt-2 text-sm text-zinc-100">{capabilityValidation.referenceImageCount} connected</div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Video refs</div>
                    <div className="mt-2 text-sm text-zinc-100">{capabilityValidation.referenceVideoCount} connected</div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Audio refs</div>
                    <div className="mt-2 text-sm text-zinc-100">{capabilityValidation.referenceAudioCount} connected</div>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Prepared assets</div>
                    <div className="mt-2 text-sm text-zinc-100">
                      {seedanceReferenceSummary.filter((item) => item.prepared).length}/{seedanceReferenceSummary.length || 0} ready
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Reference mode</div>
                    <div className="mt-2 text-sm text-zinc-100">
                      {seedanceReferenceSummary.length > 0 ? 'References' : 'Waiting for connected refs'}
                    </div>
                  </div>
                </div>
                {seedanceReferenceSummary.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {seedanceReferenceSummary.map((item) => (
                      <div key={item.edgeId} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-300">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-zinc-100">{item.sourceTitle}</span>
                          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] uppercase tracking-[0.16em] text-zinc-300">
                            {item.mediaType}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-400">
                          <span>Status: {getSeedanceAssetStatusLabel(item.status)}</span>
                          <span>Asset ID: {item.assetId || 'none'}</span>
                          <span>{item.prepared ? 'Prepared asset ready' : 'URL reference only'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : videoGenerateNode.isMultiShot ? (
            <>
              {resolvedInputs.prompt && (
                <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-sm text-cyan-100">
                  Connected prompt text stays visible in the graph, but this node ignores it while multi-shot is active.
                </div>
              )}
              <VideoFramesCard
                startFrameLabel={startFrameSourceTitle}
                endFrameLabel={endFrameSourceTitle}
                isMultiShot
              />
              <MultiShotEditor
                shots={videoGenerateNode.multiPrompts}
                onChange={(multiPrompts) => onUpdateNode(node.id, { ...node.data, multiPrompts } as Partial<WorkflowNodeData>)}
                onCreditsUpdate={onCreditsUpdate}
                selectedModel={videoModel.enhancerModelId}
                modelId={videoGenerateNode.model}
                mode={videoGenerateNode.mode}
                aspectRatio={videoGenerateNode.aspectRatio}
                sound={videoGenerateNode.sound}
                fixedLens={videoGenerateNode.fixedLens}
                hasStartImage={Boolean(resolvedInputs.startFrameUrl)}
                hasEndImage={Boolean(resolvedInputs.endFrameUrl)}
              />
            </>
          ) : (
            <>
              <VideoFramesCard
                startFrameLabel={startFrameSourceTitle}
                endFrameLabel={endFrameSourceTitle}
                isMultiShot={false}
              />
              {legacyVideoReferencesPresent && (
                <ImageReferencesCard
                  title="Legacy image references"
                  references={connectedImageReferences}
                  maxReferences={videoElementSupport?.maxElements ?? connectedImageReferences.length}
                  helperText="This older workflow still has general image references attached. New video nodes use Start frame and optional End frame instead. Remove these legacy refs when you want to fully switch to the frame-based flow."
                  onDeleteEdge={onDeleteEdge}
                />
              )}
              {videoGenerateNode.elements.length > 0 && (
                <LegacyHandledReferencesCard elements={videoGenerateNode.elements} />
              )}
            </>
          )}
        </>
      )}

      {selectedKind === 'motion-generate' && (
        <>
          <CapabilityLimitsCard graph={graph} node={node} />
          <SelectField
            label="Model"
            value={motionGenerateNode?.model || ''}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, model: value } as Partial<WorkflowNodeData>)}
            options={Object.values(MOTION_MODELS).map((modelOption) => ({
              value: modelOption.id,
              label: modelOption.displayName,
            }))}
          />
          <SelectField
            label="Resolution"
            value={motionGenerateNode?.mode || ''}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, mode: value } as Partial<WorkflowNodeData>)}
            options={motionModel ? [...motionModel.resolutions] : []}
          />
          <SelectField
            label="Character orientation"
            value={motionGenerateNode?.characterOrientation || ''}
            onChange={(value) => onUpdateNode(node.id, { ...node.data, characterOrientation: value } as Partial<WorkflowNodeData>)}
            options={motionModel ? [...motionModel.characterOrientations] : []}
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

      <button
        onClick={onDeleteNode}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100 hover:bg-rose-500/20"
      >
        <Trash2 className="h-4 w-4" /> Delete selected node
      </button>
    </div>
  );
}

function NodeDataPanel({
  graph,
  node,
  onOpenPreview,
}: {
  graph: WorkflowCanvasGraph;
  node: WorkflowCanvasNode;
  onOpenPreview: (preview: PreviewMediaState) => void;
}) {
  const dependencies = inspectWorkflowNodeDependencies(graph, node);
  const resolvedInputs = resolveNodeInputs(graph, node.id);
  const inputHandles = getWorkflowNodeInputHandles(node.type as WorkflowNodeKind);
  const outputHandles = getWorkflowNodeOutputHandles(node.type as WorkflowNodeKind);
  const outputUrl = node.data.runState.outputUrl ? getDisplayMediaUrl(node.data.runState.outputUrl) : null;
  const videoNode = node.type === 'video-generate'
    ? normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData
    : null;
  const seedanceReadiness = videoNode && isSeedance2VideoModel(videoNode.model)
    ? getSeedanceAssetSummaryItems(graph, node.id)
    : [];

  return (
    <div className="space-y-4 px-5 py-5">
      <div className={`rounded-3xl border p-4 text-sm ${
        dependencies.kind === 'blocked'
          ? 'border-rose-500/30 bg-rose-500/10 text-rose-100'
          : dependencies.kind === 'queued'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
            : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-50'
      }`}>
        <div className="text-xs uppercase tracking-[0.18em] text-current/80">Dependency state</div>
        <div className="mt-2">{dependencies.message || 'Inputs are ready for the next run.'}</div>
      </div>

      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Inputs</div>
          <div className="mt-4 grid gap-3 text-sm text-zinc-300">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
              <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Prompt</div>
              <div className="mt-2 whitespace-pre-wrap text-zinc-200">
                {resolvedInputs.prompt || 'No connected prompt text yet.'}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {(() => {
                const handledReferenceCount = getResolvedWorkflowImageReferences(graph, node.id)
                  .filter((reference) => !reference.legacy && Boolean(reference.handle))
                  .length;
                const seedanceActiveCount = seedanceReadiness.filter((item) => item.prepared).length;

                return [
                  { label: 'Image refs', value: resolvedInputs.imageReferences.length ? `${resolvedInputs.imageReferences.length} connected` : 'None' },
                  { label: 'Handled refs', value: handledReferenceCount ? `${handledReferenceCount} with @handles` : 'None' },
                  { label: 'Start frame', value: resolvedInputs.startFrameUrl ? 'Connected' : 'None' },
                  { label: 'End frame', value: resolvedInputs.endFrameUrl ? 'Connected' : 'None' },
                  { label: 'Videos', value: resolvedInputs.videoUrls.length ? `${resolvedInputs.videoUrls.length} connected` : 'None' },
                  { label: 'Audio', value: resolvedInputs.audioUrls.length ? `${resolvedInputs.audioUrls.length} connected` : 'None' },
                  ...(seedanceReadiness.length > 0 ? [
                    { label: 'Prepared assets', value: `${seedanceActiveCount}/${seedanceReadiness.length} active` },
                    { label: 'Reference mode', value: 'Seedance references' },
                  ] : []),
                ];
              })().map((item) => (
                <div key={item.label} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">{item.label}</div>
                  <div className="mt-2 text-sm text-zinc-200">{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Ports</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-sm text-zinc-300">
            <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Accepts</div>
            <div className="mt-2">{inputHandles.length > 0 ? inputHandles.join(' • ') : 'No incoming connections'}</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/20 p-3 text-sm text-zinc-300">
            <div className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Produces</div>
            <div className="mt-2">{outputHandles.length > 0 ? outputHandles.join(' • ') : 'No outgoing connections'}</div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Latest output</div>
        {outputUrl ? (
          <button
            type="button"
            onClick={() => onOpenPreview({
              kind: getNodePreviewKind(node.type as WorkflowNodeKind),
              url: outputUrl,
              title: node.data.title,
            })}
            className="mt-3 inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20"
          >
            Open latest output
          </button>
        ) : (
          <div className="mt-3 rounded-2xl border border-dashed border-white/10 bg-black/20 p-3 text-sm text-zinc-500">
            Run this node to inspect the latest output here.
          </div>
        )}
      </div>
    </div>
  );
}

function NodeRunsPanel({
  node,
  onRunBranch,
  onRunNode,
  runAffordance,
}: {
  node: WorkflowCanvasNode;
  onRunBranch: () => void;
  onRunNode: () => void;
  runAffordance: WorkflowRunAffordance | null;
}) {
  return (
    <div className="space-y-4 px-5 py-5">
      {runAffordance && (
        <div className={`rounded-3xl border p-4 text-sm ${
          runAffordance.tone === 'blocked'
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-100'
            : runAffordance.tone === 'queued'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
              : runAffordance.tone === 'static'
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-100'
                : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-50'
        }`}>
          <div className="text-xs uppercase tracking-[0.18em] text-current/80">Run readiness</div>
          <div className="mt-2">{runAffordance.message}</div>
          {runAffordance.creditLabel && (
            <div className="mt-2 text-[11px] uppercase tracking-[0.18em] text-current/80">{runAffordance.creditLabel}</div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRunNode}
          disabled={runAffordance?.runNodeDisabled}
          className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Run node
        </button>
        <button
          type="button"
          onClick={onRunBranch}
          disabled={runAffordance?.runBranchDisabled}
          className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Run from here
        </button>
      </div>

      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Latest run</div>
        <div className="mt-3 space-y-2 text-sm text-zinc-300">
          <div>Status: {node.data.runState.status}</div>
          <div>Generation ID: {node.data.runState.generationId || 'None yet'}</div>
          <div>Cost: {node.data.runState.cost ?? 'N/A'}</div>
          <div>Updated: {node.data.runState.updatedAt || 'Never'}</div>
          {node.data.runState.error && <div className="text-rose-300">{node.data.runState.error}</div>}
        </div>
      </div>
    </div>
  );
}

function getNodeGuidance(nodeType: WorkflowNodeKind): string[] {
  if (nodeType === 'motion-generate') {
    return [
      'Motion control works best with either a reference image or a reference video before you run it.',
      'Workflow motion nodes use one image reference and one video reference only, with a 30-second reference clip limit.',
      'Character orientation controls whether the motion inherits framing from the video or the image branch.',
      'Use this after a reference asset exists, not as the first media-generation step in a branch.',
    ];
  }

  if (nodeType === 'video-generate') {
    return [
      'Single-shot video keeps using the shared upstream prompt and now connects through Start frame plus optional End frame unless you switch to Seedance 2 references.',
      'Seedance 2 and Seedance 2 Fast accept connected image, video, and audio references, and they prefer prepared assets when the source nodes have an active Seedance asset id.',
      'If the node is blocked, check that a prompt node contains actual text and any connected reference image has an output.',
      'Connect one image to Start frame, then another to End frame when you want the video to transition toward a target final frame.',
      'Older workflows with general image references still run in compatibility mode, but new editing should stay frame-based.',
      'Multi-shot owns its shot prompts locally, keeps start-frame support, and disables end-frame usage for that run.',
      'Native audio only applies to supported models and can increase generation cost.',
    ];
  }

  if (nodeType === 'voiceover-generate') {
    return [
      'Voiceover nodes consume prompt text. Dialogue mode ignores upstream prompt content when dialogue turns are configured locally.',
      'Use dialogue mode for multi-speaker scripts and the standard modes for a single narrator voice.',
      'Audio outputs can be inspected here, but downstream audio routing is still limited in the current canvas engine.',
    ];
  }

  if (nodeType === 'image-generate') {
    return [
      'Image generators use one unified image-reference input. Add an optional @handle only when the prompt needs to address a specific reference directly.',
      'Handled refs and anonymous refs share the same per-model image budget: Nano Banana 2 allows up to 14 total, Nano Banana Pro allows up to 8.',
      'Use image output as a reusable first-frame source for video or motion branches.',
      'Higher resolutions increase cost and generation time, so keep test iterations at 1K until the branch is stable.',
    ];
  }

  return [
    'Use Parameters to configure this node and Data to inspect what is flowing into it.',
    'If the node is blocked, check connected inputs first before changing model settings.',
    'Right-click the node or use the quick insert affordances on handles to grow the graph from the canvas itself.',
  ];
}

function NodeNotesPanel({ node }: { node: WorkflowCanvasNode }) {
  return (
    <div className="space-y-3 px-5 py-5">
      {getNodeGuidance(node.type as WorkflowNodeKind).map((note, index) => (
        <div
          key={`${node.id}-note-${index}`}
          className="rounded-3xl border border-white/10 bg-white/[0.03] p-4 text-sm leading-relaxed text-zinc-300"
        >
          {note}
        </div>
      ))}
    </div>
  );
}

function NodeWorkspacePanel({
  activeTab,
  graph,
  node,
  onCreditsUpdate,
  onClearSelection,
  onDeleteEdge,
  onDeleteNode,
  onOpenPreview,
  onRunBranch,
  onRunNode,
  onSetError,
  onUpdateNode,
  onUploadAsset,
  runAffordance,
}: {
  activeTab: WorkflowInspectorTab;
  graph: WorkflowCanvasGraph;
  node: WorkflowCanvasNode;
  onCreditsUpdate?: (remainingCredits: number | null) => void;
  onClearSelection: () => void;
  onDeleteEdge: (edgeId: string) => void;
  onDeleteNode: () => void;
  onOpenPreview: (preview: PreviewMediaState) => void;
  onRunBranch: () => void;
  onRunNode: () => void;
  onSetError: (message: string | null) => void;
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNodeData>) => void;
  onUploadAsset: NodeEditorContentProps['onUploadAsset'];
  runAffordance: WorkflowRunAffordance | null;
}) {
  return (
    <>
      <InspectorHeader
        eyebrow="Node"
        title={node.data.title}
        description={`${getInspectorNodeTypeLabel(node.type as WorkflowNodeKind)} selected. Single click stays selection-first; Enter or double click moves you straight into Parameters.`}
        action={(
          <button
            type="button"
            aria-label="Clear selection"
            onClick={onClearSelection}
            className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === 'parameters' ? (
          <div data-testid="dock-node-editor">
            <NodeEditorContent
              graph={graph}
              node={node}
              onCreditsUpdate={onCreditsUpdate}
              onDeleteEdge={onDeleteEdge}
              onDeleteNode={onDeleteNode}
              onOpenPreview={onOpenPreview}
              onSetError={onSetError}
              onUpdateNode={onUpdateNode}
              onUploadAsset={onUploadAsset}
            />
          </div>
        ) : activeTab === 'data' ? (
          <NodeDataPanel
            graph={graph}
            node={node}
            onOpenPreview={onOpenPreview}
          />
        ) : activeTab === 'runs' ? (
          <NodeRunsPanel
            node={node}
            onRunBranch={onRunBranch}
            onRunNode={onRunNode}
            runAffordance={runAffordance}
          />
        ) : (
          <NodeNotesPanel node={node} />
        )}
      </div>
    </>
  );
}

export function WorkflowCanvasInspector({
  activePanel,
  graph,
  nodePopupPosition,
  nodes,
  onCreditsUpdate,
  selectedEdge,
  selectedNode,
  runAffordance,
  onClearSelection,
  onDeleteEdge,
  onDeleteNode,
  onOpenPreview,
  onRunBranch,
  onRunNode,
  onSetError,
  onPanelChange,
  onUpdateNode,
  onUploadAsset,
}: WorkflowCanvasInspectorProps) {
  const hasNodeSelection = Boolean(selectedNode);
  const hasEdgeSelection = Boolean(selectedEdge);
  const nodePopup = hasNodeSelection && selectedNode && activePanel === 'parameters'
    ? (
      <NodeWorkspacePanel
        activeTab="parameters"
        graph={graph}
        node={selectedNode}
        onCreditsUpdate={onCreditsUpdate}
        onClearSelection={onClearSelection}
        onDeleteEdge={onDeleteEdge}
        onDeleteNode={onDeleteNode}
        onOpenPreview={onOpenPreview}
        onRunBranch={onRunBranch}
        onRunNode={onRunNode}
        onSetError={onSetError}
        onUpdateNode={onUpdateNode}
        onUploadAsset={onUploadAsset}
        runAffordance={runAffordance}
      />
    )
    : null;
  const edgePopup = hasEdgeSelection && selectedEdge && activePanel === 'connection'
      ? (
        <EdgeSummaryPanel
          edge={selectedEdge}
          nodes={nodes}
          onClearSelection={onClearSelection}
          onDeleteEdge={onDeleteEdge}
        />
      )
      : null;
  const positionedNodePopup = nodePopup && nodePopupPosition ? nodePopup : null;
  const shouldRenderEdgeMenu = hasEdgeSelection;

  if (!positionedNodePopup && !edgePopup && !shouldRenderEdgeMenu) {
    return null;
  }

  return (
    <div data-testid="workflow-canvas-inspector" className="pointer-events-none absolute inset-0 z-30">
      {(positionedNodePopup || edgePopup) && (
        <button
          type="button"
          aria-label="Close inspector popup"
          data-testid="workflow-inspector-backdrop"
          onClick={() => onPanelChange(null)}
          className="absolute inset-0 pointer-events-auto cursor-default bg-transparent"
        />
      )}

      {positionedNodePopup && nodePopupPosition && (
        <div
          data-testid="workflow-inspector-popup"
          className="pointer-events-auto absolute flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#050505] shadow-[0_28px_120px_rgba(0,0,0,0.55)]"
          style={{
            left: nodePopupPosition.left,
            top: nodePopupPosition.top,
            width: nodePopupPosition.width,
            maxHeight: `calc(100% - ${Math.max(16, nodePopupPosition.top) + 16}px)`,
          }}
        >
          <div
            data-testid="workflow-inspector-caret"
            className="absolute bottom-[-10px] h-5 w-5 rotate-45 border-b border-r border-white/10 bg-[#050505]"
            style={{ left: nodePopupPosition.caretLeft - 10 }}
          />
          {positionedNodePopup}
        </div>
      )}

      {shouldRenderEdgeMenu && (
        <div className="absolute inset-y-4 right-4 flex items-start justify-end gap-3">
          {edgePopup && (
            <div
              data-testid="workflow-inspector-popup"
              className="pointer-events-auto flex max-h-full w-[420px] min-h-0 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#050505] shadow-[0_28px_120px_rgba(0,0,0,0.55)]"
            >
              {edgePopup}
            </div>
          )}

          <div
            data-testid="workflow-inspector-menu"
            className="pointer-events-auto flex min-w-[128px] flex-col gap-2 rounded-[24px] border border-white/10 bg-black/88 p-2 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur"
          >
            <button
              type="button"
              onClick={() => onPanelChange(activePanel === 'connection' ? null : 'connection')}
              className={`rounded-2xl border px-3 py-2 text-left text-sm transition ${
                activePanel === 'connection'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                  : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]'
              }`}
            >
              Connection
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
