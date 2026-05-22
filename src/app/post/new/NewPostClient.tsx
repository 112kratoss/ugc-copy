'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  BadgePlus,
  BookText,
  Check,
  Film,
  ImageIcon,
  Loader2,
  Plus,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { assessMarketplaceListingQuality } from '@/lib/marketplace-trust';
import {
  formatUsdCents,
  getPostResourceKindLabel,
  normalizePostResourceBundleAccessMode,
  type PostResourceAttachment,
  type PostResourceBundleInput,
  type PostResourceBundleAccessMode,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { supabase } from '@/lib/supabase';
import { CURATED_SOURCE_TOOLS, normalizeSourceToolInput } from '@/lib/source-tools';
import type { EditablePostDraft } from './post-editor-types';

type PostCategory = 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
type PostVisibility = 'public' | 'unlisted' | 'private';
type ProofMode = 'media' | 'text';
type PostFormat = 'text' | 'media' | 'mixed';

interface CreatedPostState {
  postId: string;
  showcasePath: string | null;
  ownerPath: string;
  resourceBundlePath: string | null;
  visibility: PostVisibility;
  resourceAccessMode: PostResourceBundleAccessMode;
  resourceBundleStatus: 'draft' | 'published' | null;
}

interface ComposerError {
  section: 'post' | 'story' | 'resources' | 'publish';
  message: string;
}

interface AttachmentRow {
  id: string;
  label: string;
  kind: 'link' | 'file';
  url: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number | null;
  isUploading?: boolean;
}

interface GenerationDraft {
  id: string;
  title: string;
  description: string;
  prompt: string;
  outputUrl: string | null;
  category: Exclude<PostCategory, 'text'>;
  model: string;
  paywallPrefill: GenerationPaywallPrefill | null;
}

const BODY_MAX_LENGTH = 2000;

const CATEGORY_OPTIONS: Array<{
  value: Exclude<PostCategory, 'text'>;
  label: string;
  description: string;
}> = [
  { value: 'image', label: 'Image', description: 'Still images, product frames, and visual tests' },
  { value: 'video', label: 'Video', description: 'Standard video posts from any creation tool' },
  { value: 'motion', label: 'Motion', description: 'Movement studies, animation, or motion transfer' },
  { value: 'ugc-ad', label: 'UGC ad', description: 'Creator-style ad deliverables and examples' },
];

const VISIBILITY_OPTIONS: Array<{
  value: PostVisibility;
  label: string;
  description: string;
}> = [
  {
    value: 'public',
    label: 'Public',
    description: 'Appears in the community and is shareable right away.',
  },
  {
    value: 'unlisted',
    label: 'Unlisted',
    description: 'Share by direct link only.',
  },
  {
    value: 'private',
    label: 'Private',
    description: 'Keep it private while you are still shaping the post.',
  },
];

const RESOURCE_ACCESS_OPTIONS: Array<{
  value: PostResourceBundleAccessMode;
  label: string;
  description: string;
}> = [
  {
    value: 'none',
    label: 'No unlock',
    description: 'Share the public result or tip without an unlock.',
  },
  {
    value: 'free',
    label: 'Free unlock',
    description: 'Let people reveal the prompt, notes, files, workflow, or remix access for free.',
  },
  {
    value: 'paid',
    label: 'Paid unlock',
    description: 'Charge for the reusable process behind this post.',
  },
];

const RESOURCE_KIND_OPTIONS: Array<{
  value: PostResourceKind;
  label: string;
  description: string;
}> = [
  { value: 'prompt', label: 'Prompt', description: 'The exact prompt or prompt pack.' },
  { value: 'workflow', label: 'Workflow / setup', description: 'A workflow link, file link, or build path.' },
  { value: 'files', label: 'Files / links', description: 'Reference files, docs, presets, or source links.' },
  { value: 'notes', label: 'Notes', description: 'Usage notes, steps, or instructions.' },
  { value: 'remix', label: 'Remix access', description: 'Require an unlock before someone can remix.' },
];

const UNLOCK_TEMPLATES: Array<{
  label: string;
  description: string;
  kinds: PostResourceKind[];
}> = [
  {
    label: 'Prompt only',
    description: 'Sell or share the exact prompt behind the post.',
    kinds: ['prompt'],
  },
  {
    label: 'Workflow link',
    description: 'Gate a reusable setup link or workflow URL.',
    kinds: ['workflow'],
  },
  {
    label: 'Workflow file',
    description: 'Gate workflow files, presets, source files, or references.',
    kinds: ['files'],
  },
  {
    label: 'Notes / guide',
    description: 'Gate a written guide, settings, or process notes.',
    kinds: ['notes'],
  },
  {
    label: 'Prompt + workflow',
    description: 'Bundle the prompt with the workflow or setup path.',
    kinds: ['prompt', 'workflow'],
  },
];

const EMPTY_RESOURCE_SELECTIONS: Record<PostResourceKind, boolean> = {
  prompt: false,
  workflow: false,
  files: false,
  notes: false,
  remix: false,
};

let attachmentIdCounter = 0;

function createAttachmentRow(partial?: Partial<Omit<AttachmentRow, 'id'>>): AttachmentRow {
  attachmentIdCounter += 1;

  return {
    id: `attachment-${attachmentIdCounter}`,
    label: partial?.label ?? '',
    kind: partial?.kind ?? 'link',
    url: partial?.url ?? '',
    storagePath: partial?.storagePath ?? '',
    contentType: partial?.contentType ?? '',
    sizeBytes: partial?.sizeBytes ?? null,
  };
}

function inferCategory(file: File | null): Exclude<PostCategory, 'text'> | null {
  if (!file) {
    return null;
  }

  if (file.type.startsWith('image/')) {
    return 'image';
  }

  if (file.type.startsWith('video/')) {
    return 'video';
  }

  return null;
}

function inferUploadExtension(file: File): string {
  const extension = file.name.split('.').pop()?.trim().toLowerCase();
  if (extension) {
    return extension;
  }

  if (file.type.startsWith('image/')) {
    return file.type.split('/')[1] || 'jpg';
  }

  if (file.type.startsWith('video/')) {
    return file.type.split('/')[1] || 'mp4';
  }

  return 'bin';
}

async function uploadPostMediaToSupabase(file: File, ownerUserId: string): Promise<{ storagePath: string }> {
  const fileName = `${ownerUserId}/${Math.random().toString(36).slice(2)}.${inferUploadExtension(file)}`;
  const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, file, {
    cacheControl: '3600',
    contentType: file.type || undefined,
    upsert: false,
  });

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }

  return {
    storagePath: `uploads/${fileName}`,
  };
}

function acceptsCategory(file: File | null, category: Exclude<PostCategory, 'text'>): boolean {
  if (!file) {
    return true;
  }

  if (file.type.startsWith('image/')) {
    return category === 'image' || category === 'ugc-ad';
  }

  if (file.type.startsWith('video/')) {
    return category === 'video' || category === 'motion' || category === 'ugc-ad';
  }

  return false;
}

function serializeAttachmentRows(rows: AttachmentRow[]): PostResourceAttachment[] {
  return rows
    .map((row): PostResourceAttachment | null => {
      if (row.kind === 'file') {
        const storagePath = row.storagePath.trim();
        if (!storagePath) {
          return null;
        }

        return {
          label: row.label.trim() || storagePath.split('/').pop() || 'File',
          kind: 'file' as const,
          storagePath,
          contentType: row.contentType || null,
          sizeBytes: row.sizeBytes,
        };
      }

      const url = row.url.trim();
      if (!url) {
        return null;
      }

      return {
        label: row.label.trim() || url,
        kind: 'link' as const,
        url,
      };
    })
    .filter((row): row is PostResourceAttachment => row !== null);
}

function formatGeneratedCategory(value: string | null | undefined): Exclude<PostCategory, 'text'> {
  if (value === 'video' || value === 'motion' || value === 'ugc-ad') {
    return value;
  }

  return 'image';
}

function getLockedSummary(selectedKinds: PostResourceKind[]): string {
  if (selectedKinds.length === 0) {
    return 'Nothing locked';
  }

  return selectedKinds.map((kind) => getPostResourceKindLabel(kind)).join(', ');
}

function buildDefaultResourceSummary(selectedKinds: PostResourceKind[], mode: PostResourceBundleAccessMode): string {
  if (mode === 'none') {
    return '';
  }

  const kindSummary = selectedKinds.length > 0
    ? getLockedSummary(selectedKinds).toLowerCase()
    : 'reusable process';

  return `Unlock the ${kindSummary} behind this public post.`;
}

function buildDefaultResourcePreview(selectedKinds: PostResourceKind[]): string {
  if (selectedKinds.length === 0) {
    return 'Includes reusable resources buyers can open after access.';
  }

  return `Includes ${getLockedSummary(selectedKinds).toLowerCase()} for reuse after access.`;
}

function getInitialResourceSelections(bundle: PostResourceBundleInput | null | undefined): Record<PostResourceKind, boolean> {
  const resources = bundle?.resources;
  return {
    prompt: Boolean(resources?.promptText?.trim()),
    workflow: Boolean(resources?.workflowShareUrl?.trim() || resources?.workflowSnapshot),
    files: Array.isArray(resources?.attachments) && resources.attachments.length > 0,
    notes: Boolean(resources?.notesMarkdown?.trim()),
    remix: Boolean(resources?.allowRemix),
  };
}

function getInitialAttachmentRows(bundle: PostResourceBundleInput | null | undefined): AttachmentRow[] {
  const attachments = Array.isArray(bundle?.resources?.attachments) ? bundle?.resources?.attachments : [];
  if (!attachments || attachments.length === 0) {
    return [createAttachmentRow()];
  }

    return attachments.map((attachment) =>
      createAttachmentRow({
        label: attachment.label,
        kind: attachment.kind === 'file' ? 'file' : 'link',
        url: attachment.url ?? '',
        storagePath: attachment.storagePath ?? '',
        contentType: attachment.contentType ?? '',
        sizeBytes: attachment.sizeBytes ?? null,
      })
    );
}

async function uploadResourceFile(file: File, accessToken: string): Promise<PostResourceAttachment> {
  const formData = new FormData();
  formData.set('file', file);

  const response = await fetch('/api/posts/resource-files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });
  const data = await response.json();

  if (!response.ok || !data.attachment) {
    throw new Error(data.error || 'Failed to upload resource file.');
  }

  return data.attachment as PostResourceAttachment;
}

function getInitialPriceUsd(bundle: PostResourceBundleInput | null | undefined): string {
  if (bundle?.accessMode !== 'paid') {
    return '9';
  }

  const cents = typeof bundle.priceUsdCents === 'number' ? bundle.priceUsdCents : 0;
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

function getInitialProofMode(initialPost: EditablePostDraft | null | undefined): ProofMode {
  if (!initialPost) {
    return 'media';
  }

  return initialPost.postFormat === 'text' && !initialPost.mediaUrl ? 'text' : 'media';
}

function isGenerationPaywallPrefill(value: unknown): value is GenerationPaywallPrefill {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const typedValue = value as Partial<GenerationPaywallPrefill>;
  if (!Array.isArray(typedValue.resourceKinds)) {
    return false;
  }

  const validKinds = new Set<PostResourceKind>(RESOURCE_KIND_OPTIONS.map((option) => option.value));
  if (!typedValue.resourceKinds.every((kind) => validKinds.has(kind))) {
    return false;
  }

  return (
    (typeof typedValue.promptText === 'string' || typedValue.promptText === null || typedValue.promptText === undefined) &&
    (typeof typedValue.notesMarkdown === 'string' || typedValue.notesMarkdown === null || typedValue.notesMarkdown === undefined) &&
    typeof typedValue.allowRemix === 'boolean'
  );
}

function hasUsableGenerationPaywallPrefill(prefill: GenerationPaywallPrefill | null | undefined): boolean {
  return Boolean(prefill && prefill.resourceKinds.length > 0);
}

interface NewPostClientProps {
  initialPost?: EditablePostDraft | null;
}

export default function NewPostClient({ initialPost = null }: NewPostClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session } = useAuth();
  const generationId = initialPost?.generationId ?? searchParams.get('generationId');
  const isEditMode = Boolean(initialPost);
  const publishIntent = searchParams.get('publishIntent');
  const requestedResourceMode = searchParams.get('resourceMode');
  const requestedFocusTarget = searchParams.get('focus');
  const entrySurface = searchParams.get('from');
  const isGeneratedPaywallIntent = publishIntent === 'paid-generation' && Boolean(generationId);
  const isCreationPaywallManagementIntent =
    isEditMode && entrySurface === 'creations' && requestedFocusTarget === 'price';
  const initialBundle = initialPost?.resourceBundle ?? { accessMode: 'none' as const };
  const initialResourceSelections = getInitialResourceSelections(initialBundle);
  const initialCategory =
    initialPost?.category && initialPost.category !== 'text'
      ? initialPost.category
      : 'image';
  const initialResourceAccessMode = normalizePostResourceBundleAccessMode(requestedResourceMode ?? initialBundle.accessMode);

  const [proofMode, setProofMode] = useState<ProofMode>(() => getInitialProofMode(initialPost));
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(initialPost?.title ?? '');
  const [description, setDescription] = useState(initialPost?.description ?? '');
  const [body, setBody] = useState(initialPost?.body ?? '');
  const [sourceTool, setSourceTool] = useState(initialPost?.sourceTool ?? '');
  const [sourceToolSlug, setSourceToolSlug] = useState(initialPost?.sourceToolSlug ?? '');
  const [isSourceToolSuggestionsOpen, setIsSourceToolSuggestionsOpen] = useState(false);
  const [visibility, setVisibility] = useState<PostVisibility>(initialPost?.visibility ?? 'public');
  const [category, setCategory] = useState<Exclude<PostCategory, 'text'>>(initialCategory);
  const [isDetailsOpen, setIsDetailsOpen] = useState(Boolean(initialPost?.description));
  const [resourceAccessMode, setResourceAccessMode] = useState<PostResourceBundleAccessMode>(initialResourceAccessMode);
  const [resourceSelections, setResourceSelections] = useState<Record<PostResourceKind, boolean>>(
    Object.values(initialResourceSelections).some(Boolean)
      ? initialResourceSelections
      : EMPTY_RESOURCE_SELECTIONS
  );
  const [resourceSummary] = useState(initialBundle.summary ?? '');
  const [resourcePreviewText] = useState(initialBundle.previewText ?? '');
  const [resourcePromptText, setResourcePromptText] = useState(initialBundle.resources?.promptText ?? '');
  const [resourceNotes, setResourceNotes] = useState(initialBundle.resources?.notesMarkdown ?? '');
  const [resourceWorkflowUrl, setResourceWorkflowUrl] = useState(initialBundle.resources?.workflowShareUrl ?? '');
  const [resourceAttachmentRows, setResourceAttachmentRows] = useState<AttachmentRow[]>(() => getInitialAttachmentRows(initialBundle));
  const [resourcePriceUsd, setResourcePriceUsd] = useState(() => getInitialPriceUsd(initialBundle));
  const [resourceSelectionsTouched, setResourceSelectionsTouched] = useState(false);
  const [resourcePromptTouched, setResourcePromptTouched] = useState(false);
  const [resourceNotesTouched, setResourceNotesTouched] = useState(false);
  const [didApplyGenerationPaywallPrefill, setDidApplyGenerationPaywallPrefill] = useState(false);
  const [didFocusPriceInput, setDidFocusPriceInput] = useState(false);
  const [error, setError] = useState<ComposerError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdPost, setCreatedPost] = useState<CreatedPostState | null>(null);
  const [prefilledGeneration, setPrefilledGeneration] = useState<GenerationDraft | null>(() =>
    initialPost?.generationId
      ? {
          id: initialPost.generationId,
          title: initialPost.title,
          description: initialPost.description,
          prompt: initialPost.prompt,
          outputUrl: initialPost.mediaUrl,
          category: initialCategory,
          model: 'magicbooklet',
          paywallPrefill: null,
        }
      : null
  );
  const [isLoadingGeneration, setIsLoadingGeneration] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const priceInputRef = useRef<HTMLInputElement | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const sourceToolInputRef = useRef<HTMLInputElement | null>(null);
  const postSectionRef = useRef<HTMLDivElement | null>(null);
  const storySectionRef = useRef<HTMLDivElement | null>(null);
  const resourceSectionRef = useRef<HTMLDivElement | null>(null);
  const publishSectionRef = useRef<HTMLDivElement | null>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const inferredCategory = useMemo(() => inferCategory(file), [file]);
  const existingProofUrl = initialPost?.generationId ? null : initialPost?.mediaUrl ?? null;
  const hasGeneratedProof = Boolean(prefilledGeneration);
  const selectedResourceKinds = useMemo(
    () => RESOURCE_KIND_OPTIONS.filter((option) => resourceSelections[option.value]).map((option) => option.value),
    [resourceSelections]
  );
  const trimmedBody = body.trim();
  const bodyCount = body.length;
  const hasMediaProof = proofMode === 'media' && (Boolean(file) || hasGeneratedProof || Boolean(existingProofUrl));
  const postFormat: PostFormat = hasMediaProof ? (trimmedBody ? 'mixed' : 'media') : 'text';
  const effectiveVisibility = visibility;
  const attachments = useMemo(() => serializeAttachmentRows(resourceAttachmentRows), [resourceAttachmentRows]);
  const normalizedSourceTool = useMemo(
    () => normalizeSourceToolInput({ label: sourceTool, slug: sourceToolSlug }),
    [sourceTool, sourceToolSlug]
  );
  const filteredSourceToolSuggestions = useMemo(() => {
    const normalizedQuery = sourceTool.trim().toLowerCase();

    return CURATED_SOURCE_TOOLS.filter((toolOption) => (
      normalizedQuery.length === 0 || toolOption.label.toLowerCase().includes(normalizedQuery)
    ));
  }, [sourceTool]);
  const shouldShowSourceToolSuggestions = isSourceToolSuggestionsOpen && filteredSourceToolSuggestions.length > 0;
  const generationPaywallPrefill = prefilledGeneration?.paywallPrefill ?? null;
  const hasGenerationPaywallPrefill = hasUsableGenerationPaywallPrefill(generationPaywallPrefill);
  const shouldFocusPriceInput =
    requestedFocusTarget === 'price' && (isGeneratedPaywallIntent || isCreationPaywallManagementIntent);
  const hasResourceContent = Boolean(
    (resourceSelections.prompt && resourcePromptText.trim()) ||
    (resourceSelections.notes && resourceNotes.trim()) ||
    (resourceSelections.workflow && resourceWorkflowUrl.trim()) ||
    (resourceSelections.files && attachments.length > 0) ||
    resourceSelections.remix
  );
  const parsedResourcePriceUsd = Number.parseFloat(resourcePriceUsd.trim() || '0');
  const resourcePriceUsdCents = resourceAccessMode === 'paid' && Number.isFinite(parsedResourcePriceUsd)
    ? Math.round(parsedResourcePriceUsd * 100)
    : 0;
  const defaultResourceSummary = useMemo(
    () => buildDefaultResourceSummary(selectedResourceKinds, resourceAccessMode),
    [resourceAccessMode, selectedResourceKinds]
  );
  const defaultResourcePreview = useMemo(
    () => buildDefaultResourcePreview(selectedResourceKinds),
    [selectedResourceKinds]
  );
  const resourceBundleDraft = useMemo<PostResourceBundleInput | null>(() => {
    if (resourceAccessMode === 'none') {
      return null;
    }

    return {
      accessMode: resourceAccessMode,
      summary: resourceSummary.trim() || defaultResourceSummary,
      previewText: resourcePreviewText.trim() || defaultResourcePreview,
      priceUsdCents: resourceAccessMode === 'paid' ? resourcePriceUsdCents : 0,
      resources: {
        promptText: resourceSelections.prompt ? resourcePromptText.trim() || null : null,
        notesMarkdown: resourceSelections.notes ? resourceNotes.trim() || null : null,
        workflowShareUrl: resourceSelections.workflow ? resourceWorkflowUrl.trim() || null : null,
        attachments: resourceSelections.files ? attachments : [],
        allowRemix: resourceSelections.remix,
      },
    };
  }, [
    attachments,
    defaultResourcePreview,
    defaultResourceSummary,
    resourceAccessMode,
    resourceNotes,
    resourcePreviewText,
    resourcePriceUsdCents,
    resourcePromptText,
    resourceSelections,
    resourceSummary,
    resourceWorkflowUrl,
  ]);
  const publicPostTitle = title.trim() || (trimmedBody ? trimmedBody.split(/[.!?\n]/)[0]?.trim() ?? '' : '');
  const shouldRunMarketplaceQuality = resourceAccessMode !== 'none' && effectiveVisibility === 'public';
  const marketplaceAssessment = useMemo(() => (
    resourceBundleDraft && shouldRunMarketplaceQuality
      ? assessMarketplaceListingQuality({
          title: publicPostTitle,
          summary: resourceBundleDraft.summary,
          previewText: resourceBundleDraft.previewText,
          accessMode: resourceBundleDraft.accessMode,
          priceUsdCents: resourceBundleDraft.priceUsdCents,
          resources: resourceBundleDraft.resources,
          post: {
            title: publicPostTitle,
            body: trimmedBody,
            visibility: effectiveVisibility,
            archivedAt: initialPost?.archivedAt ?? null,
            reviewStatus: 'visible',
            hasMedia: hasMediaProof,
          },
          seller: {
            name: 'Profile ready',
          },
        })
      : { eligible: true, issues: [] }
  ), [effectiveVisibility, hasMediaProof, initialPost?.archivedAt, publicPostTitle, resourceBundleDraft, shouldRunMarketplaceQuality, trimmedBody]);
  const completionChecklist = useMemo(() => [
    {
      label: 'Proof added',
      complete: hasMediaProof || trimmedBody.length >= 24,
      detail: hasMediaProof ? 'Media is attached' : trimmedBody.length >= 24 ? 'Text proof is ready' : 'Add media or switch to text',
    },
    {
      label: 'Story ready',
      complete: proofMode !== 'text' || trimmedBody.length > 0,
      detail: trimmedBody ? (proofMode === 'text' ? 'Post body is included' : 'Caption is included') : 'Add a short visible post',
    },
    {
      label: 'Unlock optional',
      complete: resourceAccessMode === 'none' || hasResourceContent,
      detail: resourceAccessMode === 'none' ? 'No unlock selected' : hasResourceContent ? getLockedSummary(selectedResourceKinds) : 'Add one asset',
    },
  ], [
    hasMediaProof,
    hasResourceContent,
    proofMode,
    resourceAccessMode,
    selectedResourceKinds,
    trimmedBody,
  ]);
  const stepBadgeLabel = hasGeneratedProof ? 'Generated media attached' : proofMode === 'text' ? 'Text post' : 'Media post';

  useEffect(() => {
    if (!previewUrl) {
      return;
    }

    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (file && !acceptsCategory(file, category) && inferredCategory) {
      setCategory(inferredCategory);
    }
  }, [category, file, inferredCategory]);

  useEffect(() => {
    setDidApplyGenerationPaywallPrefill(false);
    setDidFocusPriceInput(false);
  }, [generationId, isCreationPaywallManagementIntent, isGeneratedPaywallIntent]);

  useEffect(() => {
    if (resourceAccessMode === 'none') {
      return;
    }

    if (!Object.values(resourceSelections).some(Boolean)) {
      setResourceSelections((current) => ({
        ...current,
        prompt: true,
      }));
    }
  }, [resourceAccessMode, resourceSelections]);

  useEffect(() => {
    if (!resourceSelections.files) {
      return;
    }

    if (resourceAttachmentRows.length === 0) {
      setResourceAttachmentRows([createAttachmentRow()]);
    }
  }, [resourceAttachmentRows.length, resourceSelections.files]);

  useEffect(() => {
    if (!isGeneratedPaywallIntent || didApplyGenerationPaywallPrefill || !prefilledGeneration) {
      return;
    }

    const paywallPrefill = prefilledGeneration.paywallPrefill;
    if (!paywallPrefill || !hasUsableGenerationPaywallPrefill(paywallPrefill)) {
      setDidApplyGenerationPaywallPrefill(true);
      return;
    }

    if (!resourceSelectionsTouched) {
      setResourceSelections((current) => {
        const nextSelections = { ...current };
        for (const kind of paywallPrefill.resourceKinds) {
          nextSelections[kind] = true;
        }
        return nextSelections;
      });
    }

    if (!resourcePromptTouched && !resourcePromptText.trim() && paywallPrefill.promptText) {
      setResourcePromptText(paywallPrefill.promptText);
    }

    if (!resourceNotesTouched && !resourceNotes.trim() && paywallPrefill.notesMarkdown) {
      setResourceNotes(paywallPrefill.notesMarkdown);
    }

    setDidApplyGenerationPaywallPrefill(true);
  }, [
    didApplyGenerationPaywallPrefill,
    isGeneratedPaywallIntent,
    prefilledGeneration,
    resourceNotes,
    resourceNotesTouched,
    resourcePromptText,
    resourcePromptTouched,
    resourceSelectionsTouched,
  ]);

  useEffect(() => {
    if (
      !shouldFocusPriceInput ||
      didFocusPriceInput ||
      isLoadingGeneration ||
      resourceAccessMode !== 'paid'
    ) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      priceInputRef.current?.focus();
      priceInputRef.current?.select();
      setDidFocusPriceInput(true);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    didFocusPriceInput,
    isLoadingGeneration,
    resourceAccessMode,
    shouldFocusPriceInput,
  ]);

  useEffect(() => {
    if (!generationId || !session?.access_token) {
      setPrefilledGeneration(null);
      setGenerationError(null);
      return;
    }

    let cancelled = false;

    const loadGeneration = async () => {
      setIsLoadingGeneration(true);
      setGenerationError(null);

      try {
        const response = await fetch('/api/generations', {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load generation.');
        }

        const generation = Array.isArray(payload.generations)
          ? payload.generations.find((item: { id?: string }) => item.id === generationId)
          : null;

        if (!generation) {
          throw new Error('We could not find that generation in your account.');
        }

        if (cancelled) {
          return;
        }

        const nextGeneration: GenerationDraft = {
          id: generation.id,
          title: typeof generation.title === 'string' ? generation.title : '',
          description: typeof generation.description === 'string' ? generation.description : '',
          prompt: typeof generation.prompt === 'string' ? generation.prompt : '',
          outputUrl: typeof generation.output_url === 'string' ? generation.output_url : null,
          category: formatGeneratedCategory(generation.category),
          model: typeof generation.model === 'string' ? generation.model : 'magicbooklet',
          paywallPrefill: isGenerationPaywallPrefill(generation.paywallPrefill)
            ? generation.paywallPrefill
            : null,
        };

        setPrefilledGeneration(nextGeneration);
        setProofMode('media');
        setCategory(nextGeneration.category);
        setTitle((current) => current || nextGeneration.title);
        setDescription((current) => current || nextGeneration.description);
      } catch (loadError) {
        if (!cancelled) {
          setGenerationError(loadError instanceof Error ? loadError.message : 'Failed to load generation.');
          setPrefilledGeneration(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingGeneration(false);
        }
      }
    };

    void loadGeneration();

    return () => {
      cancelled = true;
    };
  }, [generationId, session?.access_token]);

  const resetFeedback = () => {
    setCreatedPost(null);
    setError(null);
  };

  const focusComposerSection = (section: 'post' | 'story' | 'resources' | 'publish') => {
    const target = {
      post: postSectionRef,
      story: storySectionRef,
      resources: resourceSectionRef,
      publish: publishSectionRef,
    }[section];

    window.requestAnimationFrame(() => {
      target.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.current?.focus({ preventScroll: true });
    });
  };

  const stopWithError = (message: string, section: 'post' | 'story' | 'resources' | 'publish') => {
    setError({ section, message });
    focusComposerSection(section);
  };

  const renderSectionError = (section: ComposerError['section']) => {
    if (!error || error.section !== section) {
      return null;
    }

    return (
      <div role="alert" className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
        {error.message}
      </div>
    );
  };

  const applySourceToolSelection = (toolOption: { label: string; slug: string }) => {
    setSourceTool(toolOption.label);
    setSourceToolSlug(toolOption.slug);
    setIsSourceToolSuggestionsOpen(false);
    resetFeedback();
  };

  const updateResourceSelection = (kind: PostResourceKind) => {
    setResourceSelectionsTouched(true);
    setResourceSelections((current) => ({
      ...current,
      [kind]: !current[kind],
    }));
    resetFeedback();
  };

  const applyUnlockTemplate = (templateKinds: PostResourceKind[]) => {
    const nextSelections = { ...EMPTY_RESOURCE_SELECTIONS };
    templateKinds.forEach((kind) => {
      nextSelections[kind] = true;
    });

    setResourceSelections(nextSelections);
    setResourceSelectionsTouched(true);

    if (templateKinds.includes('files') && resourceAttachmentRows.length === 0) {
      setResourceAttachmentRows([createAttachmentRow()]);
    }

    resetFeedback();
  };

  const updateAttachmentRow = (id: string, field: 'label' | 'url', value: string) => {
    setResourceAttachmentRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    );
    resetFeedback();
  };

  const handleAttachmentFileUpload = async (id: string, fileToUpload: File | null) => {
    if (!fileToUpload || !session?.access_token) {
      return;
    }

    setResourceAttachmentRows((current) =>
      current.map((row) => row.id === id ? { ...row, isUploading: true } : row)
    );
    resetFeedback();

    try {
      const uploaded = await uploadResourceFile(fileToUpload, session.access_token);
      setResourceAttachmentRows((current) =>
        current.map((row) =>
          row.id === id
            ? {
                ...row,
                label: uploaded.label,
                kind: 'file',
                url: '',
                storagePath: uploaded.storagePath ?? '',
                contentType: uploaded.contentType ?? '',
                sizeBytes: uploaded.sizeBytes ?? null,
                isUploading: false,
              }
            : row
        )
      );
    } catch (uploadError) {
      setError({
        section: 'resources',
        message: uploadError instanceof Error ? uploadError.message : 'Failed to upload resource file.',
      });
      setResourceAttachmentRows((current) =>
        current.map((row) => row.id === id ? { ...row, isUploading: false } : row)
      );
    }
  };

  const addAttachmentRow = () => {
    setResourceAttachmentRows((current) => [...current, createAttachmentRow()]);
    resetFeedback();
  };

  const removeAttachmentRow = (id: string) => {
    setResourceAttachmentRows((current) => {
      const nextRows = current.filter((row) => row.id !== id);
      return nextRows.length > 0 ? nextRows : [createAttachmentRow()];
    });
    resetFeedback();
  };

  const completePublish = (nextPost: CreatedPostState, options: { redirect?: boolean } = {}) => {
    setCreatedPost(nextPost);

    if (options.redirect) {
      const nextPath = nextPost.showcasePath ?? nextPost.ownerPath;
      if (nextPath) {
        router.push(nextPath);
      }
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setCreatedPost(null);

    if (!session?.access_token) {
      router.push('/login?returnUrl=/post/new');
      return;
    }

    if (proofMode === 'media' && !hasMediaProof) {
      stopWithError(hasGeneratedProof ? 'We could not load the generated media. Try again from My Studio.' : 'Upload an image or video to start the post.', 'post');
      return;
    }

    if (!trimmedBody && !hasMediaProof) {
      stopWithError('Add a story or media before publishing.', 'story');
      return;
    }

    if (proofMode === 'text' && !trimmedBody) {
      stopWithError('Write the story before publishing a text post.', 'story');
      return;
    }

    if (file?.type.startsWith('audio/')) {
      stopWithError('Audio posts are not supported in the community feed yet.', 'post');
      return;
    }

    if (file && !acceptsCategory(file, category)) {
      stopWithError('Choose a category that matches the file you uploaded.', 'post');
      return;
    }

    if (bodyCount > BODY_MAX_LENGTH) {
      stopWithError(`Story posts are limited to ${BODY_MAX_LENGTH} characters.`, 'story');
      return;
    }

    let resourceBundle: PostResourceBundleInput | undefined;
    if (resourceAccessMode !== 'none') {
      if (selectedResourceKinds.length === 0) {
        stopWithError('Choose at least one thing people will unlock.', 'resources');
        return;
      }

      if (resourceAccessMode === 'paid' && (!Number.isFinite(parsedResourcePriceUsd) || parsedResourcePriceUsd < 1)) {
        stopWithError('Paid unlocks must be priced at $1.00 or above.', 'resources');
        return;
      }

      if (!hasResourceContent) {
        stopWithError('Add content for at least one selected unlock item before publishing.', 'resources');
        return;
      }

      if (shouldRunMarketplaceQuality && !marketplaceAssessment.eligible) {
        const firstIssue = marketplaceAssessment.issues[0];
        stopWithError(`Improve this unlock before publishing: ${firstIssue?.message ?? 'Finish the marketplace checklist.'}`, firstIssue?.field === 'post' || firstIssue?.field === 'title' ? 'story' : 'resources');
        return;
      }

      resourceBundle = resourceBundleDraft ?? undefined;
    }

    try {
      setIsSubmitting(true);

      if (generationId) {
        const response = await fetch('/api/showcase/publish', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
            body: JSON.stringify({
            generationId,
            visibility: effectiveVisibility,
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            body: trimmedBody || undefined,
            category,
            sourceTool: normalizedSourceTool.label,
            sourceToolSlug: normalizedSourceTool.slug,
            resourceBundle: resourceBundle ?? { accessMode: 'none' },
          }),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to publish post.');
        }

        completePublish({
          postId: data.postId as string,
          showcasePath: (data.showcasePath as string | null) ?? null,
          ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
          resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
          visibility: data.visibility as PostVisibility,
          resourceAccessMode,
          resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
            ? data.resourceBundleStatus
            : null,
        }, { redirect: true });

        return;
      }

      if (isEditMode && initialPost) {
        const response = await fetch(`/api/posts/${initialPost.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            title: title.trim() || null,
            description: description.trim() || null,
            body: trimmedBody || null,
            sourceTool: sourceTool.trim() || null,
            sourceToolSlug: normalizedSourceTool.slug,
            visibility: effectiveVisibility,
            category,
            resourceBundle: resourceBundle ?? { accessMode: 'none' },
          }),
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to save post.');
        }

        completePublish({
          postId: data.postId as string,
          showcasePath: (data.showcasePath as string | null) ?? null,
          ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
          resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
          visibility: data.visibility as PostVisibility,
          resourceAccessMode,
          resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
            ? data.resourceBundleStatus
            : null,
        });

        return;
      }

      const formData = new FormData();
      formData.set('title', title);
      formData.set('description', description);
      formData.set('body', body);
      formData.set('sourceTool', sourceTool);
      if (normalizedSourceTool.slug) {
        formData.set('sourceToolSlug', normalizedSourceTool.slug);
      }
      formData.set('visibility', effectiveVisibility);
      formData.set('postFormat', postFormat);
      formData.set('resourceBundle', JSON.stringify(resourceBundle ?? { accessMode: 'none' }));

      if (hasMediaProof && file) {
        const uploadedMedia = await uploadPostMediaToSupabase(file, session.user.id);
        formData.set('mediaStoragePath', uploadedMedia.storagePath);
        formData.set('mediaContentType', file.type);
        formData.set('mediaOriginalName', file.name);
        formData.set('category', category);
      }

      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to publish post.');
      }

      completePublish({
        postId: data.postId as string,
        showcasePath: (data.showcasePath as string | null) ?? null,
        ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
        resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
        visibility: data.visibility as PostVisibility,
        resourceAccessMode,
        resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
          ? data.resourceBundleStatus
          : null,
      }, { redirect: true });
    } catch (submitError) {
      setError({
        section: 'publish',
        message: submitError instanceof Error ? submitError.message : 'Failed to publish post.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const createdPostHasResources = createdPost ? createdPost.resourceAccessMode !== 'none' : false;
  const selectedVisibilityOption = VISIBILITY_OPTIONS.find((option) => option.value === effectiveVisibility) ?? VISIBILITY_OPTIONS[0];
  const primaryPostPath = createdPost?.showcasePath ?? createdPost?.ownerPath ?? null;
  const primaryPostLabel = createdPost?.resourceBundleStatus === 'draft'
    ? 'Continue editing'
    : createdPost?.showcasePath
      ? 'View post'
      : 'Open editor';
  const primaryActionLabel = effectiveVisibility !== 'public'
    ? 'Save draft'
    : resourceAccessMode === 'none'
      ? isEditMode ? 'Save changes' : 'Share post'
      : 'Publish post + unlock';
  const backHref = isEditMode || entrySurface === 'creations' ? '/creations' : '/showcase';
  const backLabel = isEditMode || entrySurface === 'creations' ? 'Back to studio' : 'Back to community';

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-8%] h-[40%] w-[32%] rounded-full bg-sky-500/12 blur-[140px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[36%] w-[30%] rounded-full bg-emerald-500/10 blur-[160px]" />
      </div>

      {!createdPost ? (
        <div className="fixed inset-x-4 bottom-4 z-40 lg:hidden">
          <div className="flex items-center justify-between gap-3 rounded-[24px] border border-white/10 bg-zinc-950/95 p-3 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Ready when you are
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-white">
                {resourceAccessMode === 'paid'
                  ? `Paid unlock · ${formatUsdCents(Math.round((Number.parseFloat(resourcePriceUsd.trim() || '0') || 0) * 100))}`
                  : resourceAccessMode === 'free'
                    ? 'Free unlock'
                    : 'Public post'}
              </div>
            </div>
            <button
              type="submit"
              form="post-composer-form"
              disabled={isSubmitting || isLoadingGeneration}
              className="inline-flex shrink-0 items-center gap-2 rounded-full bg-sky-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgePlus className="h-4 w-4" />}
              {isEditMode ? 'Save now' : 'Share now'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="studio-shell relative z-10 py-12 sm:py-16">
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </Link>

        <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
          <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm sm:p-6">
            <div className="mb-6">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                {isCreationPaywallManagementIntent
                  ? 'Manage the unlock behind this post'
                  : isEditMode
                    ? 'Update post'
                    : 'Create post'}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-300">
                {isCreationPaywallManagementIntent
                  ? 'You came from My Studio. The media stays attached while you update the unlock, price, and visibility around this post.'
                  : isGeneratedPaywallIntent
                    ? 'The media is already attached. Saved prompt and setup details will appear here when they are available.'
                    : isEditMode
                      ? 'Update the public story first, then adjust the optional unlock and visibility around it.'
                      : 'Share the result first. Add an unlock only if there is reusable value behind it.'}
              </p>
            </div>

            <form id="post-composer-form" className="space-y-6 pb-28 lg:pb-0" onSubmit={handleSubmit}>
              {initialPost?.archivedAt ? (
                <div className="rounded-[24px] border border-amber-400/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-amber-50">
                  This post is archived. It stays out of public surfaces until you restore it from My Studio.
                </div>
              ) : null}

              <div
                ref={postSectionRef}
                tabIndex={-1}
                data-composer-section="post"
                className="rounded-3xl border border-white/8 bg-[linear-gradient(180deg,rgba(17,24,39,0.82),rgba(9,11,16,0.9))] p-5 outline-none sm:p-6"
              >
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Title</div>
                  <input
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      resetFeedback();
                    }}
                    placeholder={proofMode === 'text' ? 'Optional title, or let us derive one' : 'Give your post a clear title'}
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                  <p className="mt-2 text-xs leading-5 text-zinc-500">
                    Recommended for feed scanning and buyer trust.
                  </p>
                </label>

                {renderSectionError('post')}

                <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-t border-white/8 pt-5">
                  <div>
                    <h2 className="text-xl font-semibold text-white">Proof</h2>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                      {isEditMode
                        ? 'The post is already attached. This editor keeps the public media fixed while you update the story, visibility, and unlock around it.'
                        : hasGeneratedProof
                          ? 'Your generated media is already attached. You can tell the story and decide what unlocks next.'
                          : 'Start with media when you have a result to show, or text when you want to share a tip, note, or lesson.'}
                    </p>
                  </div>
                  {!hasGeneratedProof && !isEditMode ? (
                    <div className="inline-flex rounded-full border border-white/10 bg-black/30 p-1">
                      <button
                        type="button"
                        onClick={() => {
                          setProofMode('media');
                          resetFeedback();
                        }}
                        className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                          proofMode === 'media'
                            ? 'bg-sky-300 text-slate-950'
                            : 'text-zinc-300 hover:text-white'
                        }`}
                      >
                        Media
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setProofMode('text');
                          setFile(null);
                          resetFeedback();
                        }}
                        className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                          proofMode === 'text'
                            ? 'bg-sky-300 text-slate-950'
                            : 'text-zinc-300 hover:text-white'
                        }`}
                      >
                        Text
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-zinc-300">
                      {stepBadgeLabel}
                    </div>
                  )}
                </div>

                {proofMode === 'media' ? (
                  <div className="mt-5">
                    {hasGeneratedProof ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.02] p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Generated media</div>
                            <div className="mt-2 text-lg font-semibold text-white">
                              {prefilledGeneration?.title || 'magicbooklet creation'}
                            </div>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-300">
                              Created in magicbooklet with {prefilledGeneration?.model || 'your latest model'}.
                            </p>
                          </div>
                          <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-50">
                            Attached automatically
                          </div>
                        </div>

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {isLoadingGeneration ? (
                            <div className="flex min-h-[320px] items-center justify-center">
                              <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
                            </div>
                          ) : prefilledGeneration?.outputUrl ? (
                            category === 'video' || category === 'motion' ? (
                              <video
                                src={prefilledGeneration.outputUrl}
                                controls
                                playsInline
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={prefilledGeneration.outputUrl}
                                alt={title || 'Generated preview'}
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            )
                          ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-[18px] border border-dashed border-white/10 bg-zinc-950/60 text-center">
                              <Sparkles className="h-10 w-10 text-zinc-500" />
                              <p className="mt-4 max-w-sm text-sm leading-6 text-zinc-400">
                                The generation is attached, but the preview could not be loaded here.
                              </p>
                            </div>
                          )}
                        </div>

                        {generationError ? (
                          <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                            {generationError}
                          </div>
                        ) : null}
                      </div>
                    ) : existingProofUrl ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.02] p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Attached media</div>
                            <div className="mt-2 text-lg font-semibold text-white">
                              {title.trim() || 'Existing post media'}
                            </div>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-300">
                              This media is already saved on the post. Use the sections below to update the story or the unlock around it.
                            </p>
                          </div>
                          <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-200">
                            Media locked in
                          </div>
                        </div>

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {category === 'video' || category === 'motion' ? (
                            <video
                              src={existingProofUrl}
                              controls
                              playsInline
                              className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                            />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={existingProofUrl}
                              alt={title || 'Saved post preview'}
                              className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                            />
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-3xl border border-dashed border-white/14 bg-white/[0.02] p-5 transition hover:border-white/20 hover:bg-white/[0.03]">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center gap-4">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                              <UploadCloud className="h-6 w-6" />
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-white">Upload image or video</div>
                              <p className="mt-1 text-sm text-zinc-400">
                                Upload the public result first. Any prompt, workflow, or files can be attached later.
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => mediaInputRef.current?.click()}
                            className="inline-flex items-center justify-center gap-2 rounded-full bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-200"
                          >
                            <BadgePlus className="h-4 w-4" />
                            Add media
                          </button>
                        </div>

                        <input
                          ref={mediaInputRef}
                          type="file"
                          accept="image/*,video/*"
                          className="sr-only"
                          onChange={(event) => {
                            const nextFile = event.target.files?.[0] ?? null;
                            setFile(nextFile);
                            resetFeedback();
                          }}
                        />

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {previewUrl ? (
                            file?.type.startsWith('video/') ? (
                              <video
                                src={previewUrl}
                                controls
                                playsInline
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={previewUrl}
                                alt={title || 'Uploaded preview'}
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            )
                          ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-[18px] border border-dashed border-white/10 bg-zinc-950/60 text-center">
                              {inferredCategory === 'video' ? (
                                <Film className="h-10 w-10 text-zinc-500" />
                              ) : (
                                <ImageIcon className="h-10 w-10 text-zinc-500" />
                              )}
                              <p className="mt-4 max-w-sm text-sm leading-6 text-zinc-400">
                                Drop in the result first, then decide whether this stays a simple community post or includes an optional unlock.
                              </p>
                              <p className="mt-3 text-xs font-medium text-zinc-500">JPG, PNG, MP4, MOV</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-5 rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_34%),linear-gradient(180deg,rgba(20,20,24,0.96),rgba(10,10,14,0.96))] p-5">
                    <div className="flex items-center gap-4">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                        <BookText className="h-6 w-6" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">This will be a text post</div>
                        <p className="mt-1 text-sm text-zinc-400">
                          Use the story section below to publish the tip. You can still attach notes, files, or workflow links if the tip has reusable value.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div
                ref={storySectionRef}
                tabIndex={-1}
                data-composer-section="story"
                className="rounded-3xl border border-white/8 bg-black/20 p-5 outline-none"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Story</h2>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                      This is what everyone sees in the community before any prompt, workflow, file, or remix access unlocks.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDetailsOpen((current) => !current)}
                    className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    {isDetailsOpen ? 'Hide description' : 'Add feed description'}
                  </button>
                </div>

                {renderSectionError('story')}

                <label className="mt-5 block">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                      {proofMode === 'text' ? 'Post body' : 'Caption'}
                    </span>
                    <span className={`text-xs ${bodyCount > BODY_MAX_LENGTH ? 'text-rose-300' : 'text-zinc-500'}`}>
                      {bodyCount}/{BODY_MAX_LENGTH}
                    </span>
                  </div>
                  <textarea
                    value={body}
                    onChange={(event) => {
                      setBody(event.target.value);
                      resetFeedback();
                    }}
                    placeholder={
                      proofMode === 'text'
                        ? 'Share the tactic, lesson, or idea people should take away from this post.'
                        : 'Optional: explain what tool you used, what changed, or what someone should notice before they open an optional unlock.'
                    }
                    rows={proofMode === 'text' ? 8 : 6}
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {isDetailsOpen ? (
                  <label className="mt-5 block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Feed description</div>
                    <textarea
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value);
                        resetFeedback();
                      }}
                      placeholder="Optional: give the post a short one-line setup for feeds and previews."
                      rows={3}
                      className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                    />
                  </label>
                ) : null}

                {proofMode === 'media' ? (
                  <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
                    {!hasGeneratedProof ? (
                      <div className="rounded-[24px] border border-sky-300/15 bg-sky-400/5 p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-100/75">Source tool</div>
                            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                              Tag the tool so people can understand how this result was made.
                            </p>
                          </div>
                          <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-medium text-zinc-300">
                            {normalizedSourceTool.label || 'Choose tool'}
                          </div>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {CURATED_SOURCE_TOOLS.map((toolOption) => (
                            <button
                              key={toolOption.slug}
                              type="button"
                              onClick={() => {
                                applySourceToolSelection(toolOption);
                              }}
                              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                                normalizedSourceTool.slug === toolOption.slug
                                  ? 'border-sky-300/35 bg-sky-400/15 text-sky-50'
                                  : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                              }`}
                            >
                              {toolOption.label}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              setSourceToolSlug('');
                              setIsSourceToolSuggestionsOpen(true);
                              sourceToolInputRef.current?.focus();
                              resetFeedback();
                            }}
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                              sourceTool && !normalizedSourceTool.slug
                                ? 'border-sky-300/35 bg-sky-400/15 text-sky-50'
                                : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                            }`}
                          >
                            Custom
                          </button>
                        </div>
                        <label
                          className="mt-3 block"
                          onBlur={(event) => {
                            const nextFocusedElement = event.relatedTarget;
                            if (nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement)) {
                              return;
                            }

                            setIsSourceToolSuggestionsOpen(false);
                          }}
                        >
                          <span className="sr-only">Custom source tool</span>
                          <input
                            ref={sourceToolInputRef}
                            role="combobox"
                            aria-label="Custom source tool"
                            aria-autocomplete="list"
                            aria-controls="source-tool-suggestions"
                            aria-expanded={shouldShowSourceToolSuggestions}
                            value={sourceTool}
                            onChange={(event) => {
                              setSourceTool(event.target.value);
                              setSourceToolSlug('');
                              setIsSourceToolSuggestionsOpen(true);
                              resetFeedback();
                            }}
                            onFocus={() => {
                              setIsSourceToolSuggestionsOpen(true);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                setIsSourceToolSuggestionsOpen(false);
                              }
                            }}
                            placeholder="Runway, Midjourney, CapCut..."
                            className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                          />
                          {shouldShowSourceToolSuggestions ? (
                            <div
                              id="source-tool-suggestions"
                              role="listbox"
                              aria-label="Source tool suggestions"
                              className="mt-2 max-h-52 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950/95 p-2 shadow-[0_20px_50px_rgba(0,0,0,0.45)] backdrop-blur-xl"
                            >
                              {filteredSourceToolSuggestions.map((toolOption) => {
                                const selected = normalizedSourceTool.slug === toolOption.slug;

                                return (
                                  <button
                                    key={toolOption.slug}
                                    type="button"
                                    role="option"
                                    aria-selected={selected}
                                    onMouseDown={(event) => {
                                      event.preventDefault();
                                    }}
                                    onClick={() => {
                                      applySourceToolSelection(toolOption);
                                    }}
                                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition ${
                                      selected
                                        ? 'bg-sky-400/15 text-sky-50'
                                        : 'text-zinc-200 hover:bg-white/[0.06] hover:text-white'
                                    }`}
                                  >
                                    <span>{toolOption.label}</span>
                                    {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </label>
                      </div>
                    ) : (
                      <div className="rounded-[24px] border border-sky-300/15 bg-sky-400/5 p-4">
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-100/75">Source tool</div>
                        <div className="mt-3 inline-flex rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-sm font-medium text-zinc-100">
                          Created in magicbooklet
                        </div>
                      </div>
                    )}

                    <label className="block rounded-[24px] border border-white/8 bg-black/30 p-4">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Category</div>
                      <select
                        value={category}
                        onChange={(event) => {
                          setCategory(event.target.value as Exclude<PostCategory, 'text'>);
                          resetFeedback();
                        }}
                        disabled={hasGeneratedProof}
                        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {CATEGORY_OPTIONS.map((option) => (
                          <option
                            key={option.value}
                            value={option.value}
                            disabled={file ? !acceptsCategory(file, option.value) : false}
                            className="bg-zinc-950 text-white"
                          >
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-2 text-xs leading-5 text-zinc-500">
                        {hasGeneratedProof
                          ? 'Generated media keeps its category automatically.'
                          : CATEGORY_OPTIONS.find((option) => option.value === category)?.description}
                      </p>
                    </label>
                  </div>
                ) : null}
              </div>

              <div
                id="resources"
                ref={resourceSectionRef}
                tabIndex={-1}
                data-composer-section="resources"
                className="rounded-3xl border border-emerald-500/15 bg-emerald-500/5 p-5 outline-none"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Unlock</h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                      Attach prompts, workflows, files, notes, or remix access if this post has reusable value.
                    </p>
                  </div>
                  <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-zinc-300">
                    {resourceAccessMode === 'none' ? 'No unlock' : resourceAccessMode === 'free' ? 'Free unlock' : 'Paid unlock'}
                  </div>
                </div>

                {isGeneratedPaywallIntent ? (
                  <div className="mt-5 rounded-[24px] border border-emerald-300/18 bg-black/30 p-4 text-sm leading-6 text-zinc-200">
                    {isLoadingGeneration
                      ? 'Preparing the saved prompt and generation setup for this paid unlock.'
                      : hasGenerationPaywallPrefill
                        ? 'Saved prompt, reusable setup notes, and remix access are ready where this creation supports them. Set the price first, then publish or edit anything below.'
                        : 'This creation does not have enough saved inputs to auto-fill a paid unlock yet. The media is still attached, and you can add the prompt, notes, or remix access manually below.'}
                  </div>
                ) : isCreationPaywallManagementIntent ? (
                  <div className="mt-5 rounded-[24px] border border-emerald-300/18 bg-black/30 p-4 text-sm leading-6 text-zinc-200">
                    You came from My Studio to manage this post&apos;s unlock. The unlock mode is ready here, and the price field is focused so you can adjust the paid layer quickly.
                  </div>
                ) : null}

                {resourceAccessMode !== 'none' && effectiveVisibility !== 'public' ? (
                  <div className="mt-4 rounded-[24px] border border-white/8 bg-black/25 px-4 py-3 text-sm text-zinc-200">
                    This unlock will save as a draft until the post is public.
                  </div>
                ) : null}

                {renderSectionError('resources')}

                <div className="mt-5 inline-flex rounded-full border border-white/10 bg-black/30 p-1">
                  {RESOURCE_ACCESS_OPTIONS.map((option) => {
                    const active = resourceAccessMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setResourceAccessMode(option.value);
                          resetFeedback();
                        }}
                        className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                          active
                            ? 'bg-emerald-300 text-emerald-950'
                            : 'text-zinc-300 hover:text-white'
                        }`}
                      >
                        {option.value === 'none' ? 'No unlock' : option.label}
                      </button>
                    );
                  })}
                </div>

                {resourceAccessMode === 'none' ? (
                  <p className="mt-4 text-sm leading-6 text-zinc-300">
                    Keep the post simple by default. Add an unlock only when there is a reusable prompt, workflow, file, note, or remix path worth sharing.
                  </p>
                ) : (
                  <div className="mt-5 space-y-5">
                    <div className="rounded-[24px] border border-white/8 bg-black/25 p-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Custom package contents</div>
                      <p className="mt-2 text-sm leading-6 text-zinc-400">
                        Select only the reusable pieces people should reveal after choosing this unlock.
                      </p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {UNLOCK_TEMPLATES.map((template) => {
                          const active =
                            template.kinds.every((kind) => resourceSelections[kind]) &&
                            selectedResourceKinds.length === template.kinds.length;

                          return (
                            <button
                              key={template.label}
                              type="button"
                              onClick={() => applyUnlockTemplate(template.kinds)}
                              className={`rounded-[18px] border p-3 text-left transition ${
                                active
                                  ? 'border-emerald-300/35 bg-emerald-400/15 text-white'
                                  : 'border-white/10 bg-white/[0.025] text-zinc-300 hover:border-white/20 hover:bg-white/[0.05] hover:text-white'
                              }`}
                            >
                              <div className="text-sm font-semibold">{template.label}</div>
                              <p className="mt-1 text-xs leading-5 text-zinc-500">{template.description}</p>
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {RESOURCE_KIND_OPTIONS.map((option) => {
                          const active = resourceSelections[option.value];

                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => updateResourceSelection(option.value)}
                              title={option.description}
                              className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-semibold transition ${
                                active
                                  ? 'border-emerald-300/35 bg-emerald-400/15 text-emerald-50'
                                  : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/20 hover:bg-white/[0.06] hover:text-white'
                              }`}
                            >
                              {active ? <Check className="h-4 w-4 text-emerald-200" /> : null}
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {resourceSelections.prompt ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Prompt</div>
                        <textarea
                          value={resourcePromptText}
                          onChange={(event) => {
                            setResourcePromptTouched(true);
                            setResourcePromptText(event.target.value);
                            resetFeedback();
                          }}
                          rows={6}
                          placeholder="Paste the exact prompt people should unlock."
                          className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.notes ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Notes</div>
                        <textarea
                          value={resourceNotes}
                          onChange={(event) => {
                            setResourceNotesTouched(true);
                            setResourceNotes(event.target.value);
                            resetFeedback();
                          }}
                          rows={6}
                          placeholder="Add the steps, settings, or instructions that make this reusable."
                          className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.workflow ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Workflow / setup link</div>
                        <input
                          value={resourceWorkflowUrl}
                          onChange={(event) => {
                            setResourceWorkflowUrl(event.target.value);
                            resetFeedback();
                          }}
                          placeholder="https://..."
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.files ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Files / links</div>
                            <p className="mt-1 text-sm leading-6 text-zinc-400">
                              Add gated workflow files or labeled links people should open after unlocking. Resource file uploads must be 50MB or smaller.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={addAttachmentRow}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                          >
                            <Plus className="h-4 w-4" />
                            Add link
                          </button>
                        </div>

                        <div className="mt-4 space-y-3">
                          {resourceAttachmentRows.map((row, index) => (
                            <div key={row.id} className="grid gap-3 rounded-[20px] border border-white/8 bg-white/[0.03] p-3 md:grid-cols-[minmax(0,180px)_1fr_auto]">
                              <input
                                value={row.label}
                                onChange={(event) => updateAttachmentRow(row.id, 'label', event.target.value)}
                                placeholder={`Label ${index + 1}`}
                                className="rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                              />
                              <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                                {row.kind === 'file' && row.storagePath ? (
                                  <div className="rounded-2xl border border-emerald-300/15 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-50">
                                    {row.label || row.storagePath}
                                    {row.sizeBytes ? (
                                      <span className="ml-2 text-xs text-emerald-50/65">{Math.ceil(row.sizeBytes / 1024)} KB</span>
                                    ) : null}
                                  </div>
                                ) : (
                                  <input
                                    value={row.url}
                                    onChange={(event) => updateAttachmentRow(row.id, 'url', event.target.value)}
                                    placeholder="https://..."
                                    className="rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                                  />
                                )}
                                <label className="inline-flex cursor-pointer items-center justify-center rounded-2xl border border-white/10 bg-black/35 px-3 py-3 text-sm font-medium text-zinc-200 transition hover:bg-black/45 hover:text-white">
                                  {row.isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Upload file'}
                                  <input
                                    type="file"
                                    className="sr-only"
                                    disabled={row.isUploading}
                                    onChange={(event) => {
                                      void handleAttachmentFileUpload(row.id, event.target.files?.[0] ?? null);
                                      event.target.value = '';
                                    }}
                                  />
                                </label>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeAttachmentRow(row.id)}
                                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-black/35 px-3 py-3 text-zinc-300 transition hover:bg-black/45 hover:text-white"
                                aria-label={`Remove link ${index + 1}`}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {resourceSelections.remix ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                        <div className="text-sm font-semibold text-white">Remix access is included in this unlock</div>
                        <p className="mt-1 text-sm leading-6 text-zinc-400">
                          People will need to open this unlock before remixing this post.
                        </p>
                      </div>
                    ) : null}

                    {resourceAccessMode === 'paid' ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Price</div>
                        <input
                          ref={priceInputRef}
                          value={resourcePriceUsd}
                          onChange={(event) => {
                            setResourcePriceUsd(event.target.value);
                            resetFeedback();
                          }}
                          placeholder="9"
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                        <p className="mt-2 text-xs leading-5 text-zinc-500">Choose any price at or above $1.00.</p>
                      </label>
                    ) : null}
                  </div>
                )}
              </div>

              {createdPost ? (
                <div className="rounded-[28px] border border-emerald-500/20 bg-emerald-500/10 p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="text-sm font-semibold text-white">
                      {isEditMode
                        ? 'Changes saved'
                        : createdPost.resourceBundleStatus === 'draft'
                          ? 'Draft saved with an unlock'
                          : createdPostHasResources
                            ? 'Post published with an unlock'
                            : 'Post published'}
                    </div>
                    <div className="rounded-full border border-emerald-300/20 bg-black/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-50">
                      {createdPost.visibility}
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-emerald-50/90">
                    {isEditMode
                      ? createdPost.visibility === 'private'
                        ? 'Your changes are saved in the owner editor. This post is not publicly visible right now.'
                        : 'The post has been updated and the latest version is ready.'
                      : createdPost.resourceBundleStatus === 'draft'
                        ? 'The public post and unlock are saved for you. Make the post public when you are ready to list the unlock.'
                        : createdPostHasResources
                          ? 'The post is public and the unlockable process is ready on the same page.'
                          : createdPost.visibility === 'public'
                            ? 'Your post is live.'
                            : 'Your post is saved with limited visibility.'}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    {primaryPostPath ? (
                      <Link
                        href={primaryPostPath}
                        className="rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
                      >
                        {primaryPostLabel}
                      </Link>
                    ) : null}
                    {createdPostHasResources && createdPost.resourceBundlePath ? (
                      <Link
                        href={createdPost.resourceBundlePath}
                        className="rounded-full border border-emerald-300/30 bg-emerald-400/15 px-4 py-2.5 text-sm font-semibold text-emerald-50 transition hover:border-emerald-200/40 hover:bg-emerald-400/20"
                      >
                        Open unlock section
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div
                ref={publishSectionRef}
                tabIndex={-1}
                data-composer-section="publish"
                className="rounded-3xl border border-white/8 bg-zinc-950/75 p-5 outline-none"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Publish</h2>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                      Choose who can see this post. Non-public unlocks stay draft-only.
                    </p>
                  </div>
                  <div className="shrink-0 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold text-zinc-300">
                    {resourceAccessMode === 'none'
                      ? selectedVisibilityOption.label
                      : resourceAccessMode === 'paid'
                        ? `${selectedVisibilityOption.label} · paid unlock`
                        : `${selectedVisibilityOption.label} · free unlock`}
                  </div>
                </div>

                {renderSectionError('publish')}

                <div className="mt-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Visibility</div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {VISIBILITY_OPTIONS.map((option) => {
                      const active = visibility === option.value;
                      const description = resourceAccessMode === 'none'
                        ? option.description
                        : option.value === 'public'
                          ? 'Publishes the post and makes a complete unlock buyer-facing.'
                          : option.value === 'unlisted'
                            ? 'Saves the post by direct link and keeps the unlock as a draft.'
                            : 'Saves everything as an owner-only draft.';

                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-label={option.label}
                          onClick={() => {
                            setVisibility(option.value);
                            resetFeedback();
                          }}
                          className={`rounded-2xl border px-4 py-3 text-left transition ${
                            active
                              ? 'border-emerald-300/35 bg-emerald-400/12 text-white'
                              : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:border-white/20 hover:bg-white/[0.04] hover:text-white'
                          }`}
                        >
                          <div className="text-sm font-semibold">{option.label}</div>
                          <p className="mt-2 text-xs leading-5 text-zinc-400">{description}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap justify-end gap-3 border-t border-white/8 pt-5">
                  <Link
                    href={isEditMode ? '/creations' : '/showcase'}
                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    {isEditMode ? 'Back to studio' : 'Back to community'}
                  </Link>
                  <button
                    type="submit"
                    disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                    className="inline-flex items-center gap-2 rounded-full bg-sky-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgePlus className="h-4 w-4" />}
                    {primaryActionLabel}
                  </button>
                </div>
              </div>
            </form>
          </section>

          <aside aria-label="Publish checklist" className="lg:sticky lg:top-24">
            <div className="rounded-3xl border border-white/8 bg-zinc-900/60 p-5 shadow-[0_20px_50px_rgba(0,0,0,0.28)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Publish checklist</div>
              <div className="mt-4 space-y-3">
                {completionChecklist.map((item) => (
                  <div key={item.label} className="flex items-start gap-3">
                    <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                      item.complete
                        ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-100'
                        : 'border-white/10 bg-white/[0.04] text-zinc-500'
                    }`}>
                      {item.complete ? <Check className="h-4 w-4" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{item.label}</div>
                      <p className="mt-1 text-xs leading-5 text-zinc-400">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
