'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  BadgePlus,
  BookText,
  Check,
  Film,
  GripVertical,
  ImageIcon,
  Loader2,
  Maximize2,
  Plus,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import {
  assessMarketplaceListingQuality,
  getPublicPostQualityError,
  isCreatorProfileReadinessError,
} from '@/lib/marketplace-trust';
import { createClientPostMediaKey, defaultPostMediaKey } from '@/lib/post-media-key';
import {
  POST_VIDEO_DURATION_LIMIT_MESSAGE,
  POST_VIDEO_MAX_DURATION_SECONDS,
  POST_VIDEO_MAX_UPLOAD_BYTES,
  POST_VIDEO_UPLOAD_BYTES_MESSAGE,
} from '@/lib/post-video-limits';
import { getCurrentInternalPath, getSafeInternalReturnPath } from '@/lib/share';
import { trackProductEvent } from '@/lib/product-analytics';
import {
  getPostResourceKindLabel,
  getPostResourceKinds,
  normalizePostResourceItems,
  normalizePostResourceBundleAccessMode,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  POST_RESOURCE_PRICE_INCREMENT_USD_CENTS,
  type PostResourceAttachment,
  type PostResourceBundleInput,
  type PostResourceBundleAccessMode,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import {
  POST_RESOURCE_WEB_CASH_MIN_TOKENS,
} from '@/lib/post-resource-commerce';
import { slugifySourceTool, type SourceToolOption } from '@/lib/source-tools';
import {
  resolveSignedUploadUrl,
  uploadFileToSignedUrl,
  type SignedUrlUploadProgress,
} from '@/lib/signed-url-upload';
import { uploadMediaToTemporaryStorage } from '@/lib/temporary-media-upload';
import { finalizeSignedUpload } from '@/lib/upload-finalize-client';
import { isUploadCancelledError, runWeightedUploadQueue, UploadCancelledError } from '@/lib/upload-queue';
import type { ShowcaseItemCategory } from '@/lib/showcase';
import {
  buildResourceCardBundleInput,
  buildResourceCardItems,
  createPostComposerResourceCard,
  getResourceCardPreview,
  hydratePostComposerAllowRemix,
  hydratePostComposerResourceCards,
  resourceCardHasContent,
  type PostComposerResourceCardDraft,
  type PostComposerResourceCardType,
} from '@/lib/post-composer-resource-cards';
import ComposerMediaLightbox, { getComposerMediaLabel } from './ComposerMediaLightbox';
import ResourceCardEditorDialog from './ResourceCardEditorDialog';
import ResourceCardsSection from './ResourceCardsSection';
import CreatableCombobox, { type CreatableComboboxOption } from './CreatableCombobox';
import type { EditablePostDraft } from './post-editor-types';

type PostVisibility = 'public' | 'unlisted' | 'private';
type ProofMode = 'media' | 'text';
type PostFormat = 'text' | 'media' | 'mixed';
type PostMediaCategory = Exclude<ShowcaseItemCategory, 'text'>;

interface MadeWithRow {
  id: string;
  toolLabel: string;
  toolSlug: string;
  modelLabel: string;
  modelSlug: string;
  createTool: boolean;
  createModel: boolean;
}

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
  actionHref?: string;
  actionLabel?: string;
}

interface ComposerMediaItem {
  id: string;
  existingId: string | null;
  /**
   * The key a resource scope points at. Minted here for new media and submitted
   * with it, so scoping survives reordering; media already on the post keeps
   * the key the server stored, or the positional one the server derives for
   * rows written before keys existed.
   */
  mediaKey: string;
  file: File | null;
  existingUrl: string | null;
  mediaKind: 'image' | 'video';
  contentType: string | null;
  originalName: string | null;
  /**
   * Set once the file has been staged into the uploads bucket, and kept across
   * failed publish attempts: a retry must re-upload only what actually failed,
   * not re-send files that already made it up.
   */
  storagePath: string | null;
  /**
   * Measured from the picked file's metadata at append time; null when the
   * browser could not read it. Client-reported and therefore advisory — the
   * rendition sweep's probe is the value of record server-side.
   */
  durationSeconds?: number | null;
}

/**
 * Aggregate upload state for the publish step.
 *
 * Uploading still happens at submit rather than at pick time, so this is the
 * only window where the user is waiting on bytes -- and before this they waited
 * on a spinner that could not say how long, could not be cancelled, and threw
 * away completed uploads if any single file failed.
 */
interface MediaUploadProgress {
  bytesSent: number;
  totalBytes: number;
  completed: number;
  total: number;
  percent: number;
}

function formatUploadBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

class ComposerSubmissionError extends Error {
  readonly section: ComposerError['section'];
  readonly actionHref?: string;
  readonly actionLabel?: string;

  constructor(
    message: string,
    section: ComposerError['section'],
    action?: { href: string; label: string }
  ) {
    super(message);
    this.name = 'ComposerSubmissionError';
    this.section = section;
    this.actionHref = action?.href;
    this.actionLabel = action?.label;
  }
}

function buildProfileRepairHref(): string {
  return '/profile?source=post-composer';
}

function getSubmissionError(
  data: { error?: string; field?: string; actionHref?: string; actionLabel?: string },
  fallback: string
) {
  const message = data.error || fallback;
  const needsProfileRepair = data.field === 'profile' || isCreatorProfileReadinessError(message);
  return new ComposerSubmissionError(
    message,
    data.field === 'sourceTools' ? 'post' : 'publish',
    needsProfileRepair
      ? {
          href: buildProfileRepairHref(),
          label: 'Complete profile in a new tab',
        }
      : undefined
  );
}

interface GenerationDraft {
  id: string;
  title: string;
  description: string;
  prompt: string;
  outputUrl: string | null;
  category: PostMediaCategory;
  model: string;
  paywallPrefill: GenerationPaywallPrefill | null;
  /**
   * Edit mode seeds a draft from the server-rendered post before the
   * generations fetch resolves. The paywall prefill must only conclude
   * "nothing to apply" from a fetched draft — the seed never carries one.
   */
  source: 'seed' | 'fetched';
}

const BODY_MAX_LENGTH = 2000;
// Mirrors TITLE_MAX_LENGTH in posts-server.ts, which is the gate that actually
// rejects. This copy exists only because posts-server.ts is `server-only` and
// cannot be imported into a client component — keep the two in step.
const TITLE_MAX_LENGTH = 100;

// Media reorder gesture, matched to the mobile composer so the interaction reads
// the same on both. w-28 (112px) + gap-3 (12px) is how far one slot is.
const MEDIA_CARD_STEP = 124;
const MEDIA_DRAG_HOLD_MS = 300;
const MEDIA_DRAG_SLOP = 8;

const RESOURCE_KIND_OPTIONS: Array<{
  value: PostResourceKind;
  label: string;
  description: string;
}> = [
  { value: 'prompt', label: 'Prompt', description: 'The exact prompt or prompt pack.' },
  { value: 'workflow', label: 'Workflow / setup', description: 'A workflow link, file link, or build path.' },
  { value: 'files', label: 'Files / links', description: 'Reference files, docs, presets, or source links.' },
  { value: 'notes', label: 'Notes', description: 'Usage notes, steps, or instructions.' },
  { value: 'remix', label: 'Remix access', description: 'Require recipe access before someone can remix.' },
];

/**
 * A bundle written before structured items existed carries its content only in
 * the flat `promptText` / `notesMarkdown` / `workflowShareUrl` / `attachments`
 * fields. Running the same legacy synthesis the server uses turns those into
 * items, so the card composer can open an old recipe instead of showing it as
 * empty and dropping it on save.
 */
function withSynthesizedResourceItems(
  bundle: PostResourceBundleInput | null | undefined
): PostResourceBundleInput | null {
  if (!bundle?.resources) {
    return bundle ?? null;
  }

  return {
    ...bundle,
    resources: {
      ...bundle.resources,
      items: normalizePostResourceItems(bundle.resources.items, bundle.resources),
    },
  };
}

function inferCategoryFromContentType(contentType: string | null | undefined): PostMediaCategory | null {
  if (!contentType) {
    return null;
  }

  if (contentType.startsWith('image/')) {
    return 'image';
  }

  if (contentType.startsWith('video/')) {
    return 'video';
  }

  return null;
}

/**
 * How long the metadata probe may stall before the file is let through with an
 * unknown duration. Metadata loads resolve in milliseconds when they resolve
 * at all; a codec the browser chokes on must not wedge the composer.
 */
const VIDEO_METADATA_READ_TIMEOUT_MS = 4000;

/**
 * Reads a picked video's duration from a metadata-only load (the pattern
 * CreateMotionClient uses for reference clips). Resolves null when the browser
 * cannot read it — the caller lets those through for the server layers, whose
 * ffmpeg probe of the actual file is the authoritative check anyway.
 */
function readVideoFileDurationSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    let probe: HTMLVideoElement;
    let objectUrl: string;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      probe.removeEventListener('loadedmetadata', handleLoadedMetadata);
      probe.removeEventListener('error', handleError);
      probe.src = '';
      URL.revokeObjectURL(objectUrl);
      resolve(value);
    };

    const handleLoadedMetadata = () => {
      finish(Number.isFinite(probe.duration) ? probe.duration : null);
    };
    const handleError = () => finish(null);

    try {
      probe = document.createElement('video');
      // An empty canPlayType means this browser could not decode the file, so
      // a metadata load would only ever end in the error path — skip straight
      // to "unknown". (This is also what keeps jsdom-based tests, whose media
      // elements never fire load events, from hanging here.)
      if (!probe.canPlayType || probe.canPlayType(file.type) === '') {
        resolve(null);
        return;
      }
      probe.preload = 'metadata';
      objectUrl = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }

    timeout = setTimeout(() => finish(null), VIDEO_METADATA_READ_TIMEOUT_MS);
    probe.addEventListener('loadedmetadata', handleLoadedMetadata);
    probe.addEventListener('error', handleError);
    probe.src = objectUrl;
  });
}

function createComposerMediaItem(file: File, index: number, durationSeconds: number | null = null): ComposerMediaItem {
  return {
    id: `new-${Date.now()}-${index}-${file.name}`,
    existingId: null,
    mediaKey: createClientPostMediaKey(),
    file,
    existingUrl: null,
    mediaKind: file.type.startsWith('video/') ? 'video' : 'image',
    contentType: file.type || null,
    originalName: file.name,
    storagePath: null,
    durationSeconds,
  };
}

function formatGeneratedCategory(value: string | null | undefined): PostMediaCategory {
  if (value === 'video' || value === 'motion' || value === 'ugc-ad') {
    return 'video';
  }

  return 'image';
}

function getLockedSummary(selectedKinds: PostResourceKind[]): string {
  if (selectedKinds.length === 0) {
    return 'Nothing locked';
  }

  return selectedKinds.map((kind) => getPostResourceKindLabel(kind)).join(', ');
}

function getVisibilityStatusLabel(v: PostVisibility): string {
  if (v === 'public') return 'Visible in Showcase';
  if (v === 'unlisted') return 'Shareable by link only';
  return 'Saved privately in Studio';
}

async function uploadResourceFile(
  file: File,
  accessToken: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: SignedUrlUploadProgress) => void;
  } = {},
): Promise<PostResourceAttachment> {
  try {
    if (options.signal?.aborted) throw new UploadCancelledError();
    const contentType = file.type || 'application/octet-stream';
    const signResponse = await fetch('/api/posts/resource-files/sign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        fileName: file.name,
        contentType,
        sizeBytes: file.size,
      }),
      signal: options.signal,
    });
    const uploadIntent = await signResponse.json() as {
      bucket?: 'post_resource_files';
      uploadId?: string;
      path?: string;
      token?: string;
      signedUploadUrl?: string | null;
      expected?: { fileName?: string; contentType?: string; sizeBytes?: number };
      error?: string;
    };

    if (
      !signResponse.ok
      || uploadIntent.bucket !== 'post_resource_files'
      || !uploadIntent.uploadId
      || !uploadIntent.path
      || !uploadIntent.token
    ) {
      throw new Error(uploadIntent.error || 'Failed to prepare resource upload.');
    }

    // The server resolves the content type from the extension when the browser
    // cannot name one, and finalize compares the stored object against that
    // resolution -- so the upload has to carry the server's answer, not ours.
    const resolvedContentType = uploadIntent.expected?.contentType || contentType;
    await uploadFileToSignedUrl(
      file,
      resolveSignedUploadUrl({
        bucket: uploadIntent.bucket,
        path: uploadIntent.path,
        token: uploadIntent.token,
        signedUploadUrl: uploadIntent.signedUploadUrl,
      }),
      {
        mimeType: resolvedContentType,
        onProgress: options.onProgress,
        signal: options.signal,
      },
    );

    if (options.signal?.aborted) throw new UploadCancelledError();
    const finalized = await finalizeSignedUpload(
      accessToken,
      uploadIntent.uploadId,
      options.signal,
    );
    if (finalized.bucket !== uploadIntent.bucket || finalized.path !== uploadIntent.path) {
      throw new Error('Finalized resource upload did not match its signed target.');
    }

    if (options.signal?.aborted) throw new UploadCancelledError();
    return {
      label: file.name,
      kind: 'file',
      storagePath: finalized.path,
      contentType: finalized.contentType,
      sizeBytes: finalized.sizeBytes,
    };
  } catch (error) {
    if (options.signal?.aborted && !isUploadCancelledError(error)) {
      throw new UploadCancelledError();
    }
    throw error;
  }
}

const DEFAULT_PRICE_TOKENS = 900;

/**
 * Prices are denominated in tokens, and `price_usd_cents` stores the token
 * count directly -- at the fixed 100-token/$1 rate the two numbers are equal.
 */
function getInitialPriceTokens(bundle: PostResourceBundleInput | null | undefined): string {
  if (bundle?.accessMode !== 'paid') {
    return String(DEFAULT_PRICE_TOKENS);
  }

  const tokens = typeof bundle.priceUsdCents === 'number' ? bundle.priceUsdCents : 0;
  return tokens > 0 ? String(Math.round(tokens)) : String(DEFAULT_PRICE_TOKENS);
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
  const initialCategory =
    initialPost?.category && initialPost.category !== 'text'
      ? initialPost.category
      : 'image';
  const initialResourceAccessMode = normalizePostResourceBundleAccessMode(requestedResourceMode ?? initialBundle.accessMode);

  const [proofMode, setProofMode] = useState<ProofMode>(() => getInitialProofMode(initialPost));
  // Edit mode seeds from the server-rendered post — generation-backed posts
  // included: their media is display-only here (the submit path never sends
  // mediaItems for them), and leaving the state empty blanked the proof and
  // the per-media resource scoping whenever the generations fetch failed.
  const [mediaItems, setMediaItems] = useState<ComposerMediaItem[]>(() => {
    if (initialPost?.mediaItems?.length) {
      return initialPost.mediaItems.map((item, index) => ({
        id: `existing-${item.id}`,
        existingId: item.id,
        // Rows written before media keys existed have none stored, and the
        // server derives the same positional key for them on every read.
        mediaKey: item.mediaKey ?? defaultPostMediaKey(index),
        file: null,
        existingUrl: item.url,
        mediaKind: item.mediaKind,
        contentType: item.contentType,
        originalName: item.originalName,
        storagePath: null,
      }));
    }

    if (initialPost?.mediaUrl && initialPost.mediaKind) {
      return [{
        id: 'existing-cover',
        existingId: `${initialPost.id}:cover`,
        mediaKey: defaultPostMediaKey(0),
        file: null,
        existingUrl: initialPost.mediaUrl,
        mediaKind: initialPost.mediaKind,
        contentType: null,
        originalName: null,
        storagePath: null,
      }];
    }

    return [];
  });
  const [isDragging, setIsDragging] = useState(false);
  const [draggedMediaId, setDraggedMediaId] = useState<string | null>(null);
  // rawTitle, never the display title: the read APIs substitute "Untitled
  // post" for an empty title, and echoing that back on save trips the
  // marketplace placeholder gate.
  const [title, setTitle] = useState(initialPost ? (initialPost.rawTitle ?? initialPost.title ?? '') : '');
  const [description, setDescription] = useState(initialPost?.description ?? '');
  const [body, setBody] = useState(initialPost?.body ?? '');
  const [madeWithRows, setMadeWithRows] = useState<MadeWithRow[]>(() => {
    if (initialPost?.sourceTools && initialPost.sourceTools.length > 0) {
      return initialPost.sourceTools.map((st, i) => ({
        id: `mw-${i}`,
        toolLabel: st.toolLabel,
        toolSlug: st.toolSlug ?? '',
        modelLabel: st.modelLabel ?? '',
        modelSlug: st.modelSlug ?? '',
        createTool: st.createTool === true,
        createModel: st.createModel === true,
      }));
    }
    if (initialPost?.sourceTool) {
      return [{
        id: 'mw-0',
        toolLabel: initialPost.sourceTool,
        toolSlug: initialPost.sourceToolSlug ?? '',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      }];
    }
    if (initialPost?.generationId || generationId) {
      return [{
        id: 'mw-0',
        toolLabel: 'magicbooklet',
        toolSlug: 'magicbooklet',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      }];
    }
    return [{
      id: 'mw-0',
      toolLabel: '',
      toolSlug: '',
      modelLabel: '',
      modelSlug: '',
      createTool: false,
      createModel: false,
    }];
  });
  const [sourceToolsData, setSourceToolsData] = useState<SourceToolOption[]>([]);
  const [visibility, setVisibility] = useState<PostVisibility>(initialPost?.visibility ?? 'public');
  const [category, setCategory] = useState<PostMediaCategory>(initialCategory);
  const [isDetailsOpen, setIsDetailsOpen] = useState(Boolean(initialPost?.description));
  const [resourceAccessMode, setResourceAccessMode] = useState<PostResourceBundleAccessMode>(initialResourceAccessMode);
  // One card is one thing a buyer receives. The serialization lives in
  // post-composer-resource-cards.ts, which the mobile composer mirrors.
  const [resourceCards, setResourceCards] = useState<PostComposerResourceCardDraft[]>(
    () => hydratePostComposerResourceCards(withSynthesizedResourceItems(initialBundle))
  );
  const [resourceAllowRemix, setResourceAllowRemix] = useState(
    () => hydratePostComposerAllowRemix(initialBundle)
  );
  const [resourceSummary, setResourceSummary] = useState(initialBundle.summary ?? '');
  const [resourcePreviewText, setResourcePreviewText] = useState(initialBundle.previewText ?? '');
  const [resourcePriceTokens, setResourcePriceTokens] = useState(() => getInitialPriceTokens(initialBundle));
  const [editingResourceCard, setEditingResourceCard] = useState<PostComposerResourceCardDraft | null>(null);
  const [isChoosingResourceType, setIsChoosingResourceType] = useState(false);
  const [didApplyGenerationPaywallPrefill, setDidApplyGenerationPaywallPrefill] = useState(false);
  const [didFocusPriceInput, setDidFocusPriceInput] = useState(false);
  const [error, setError] = useState<ComposerError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<MediaUploadProgress | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
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
          source: 'seed',
        }
      : null
  );
  const [isLoadingGeneration, setIsLoadingGeneration] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const submitVisibilityRef = useRef<PostVisibility>(initialPost?.visibility ?? 'public');
  const formRef = useRef<HTMLFormElement | null>(null);
  const priceInputRef = useRef<HTMLInputElement | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const postSectionRef = useRef<HTMLDivElement | null>(null);
  const storySectionRef = useRef<HTMLDivElement | null>(null);
  const resourceSectionRef = useRef<HTMLDivElement | null>(null);
  const publishSectionRef = useRef<HTMLDivElement | null>(null);

  const mediaPreviewItems = useMemo(
    () => mediaItems.map((item) => ({
      ...item,
      previewUrl: item.file ? URL.createObjectURL(item.file) : item.existingUrl,
    })),
    [mediaItems]
  );
  const coverPreviewItem = mediaPreviewItems[0] ?? null;

  // Reordering swaps DOM nodes, which the browser paints instantly — the cards
  // teleport. FLIP fixes that: after React commits the new order, each card is
  // offset back to where it just was and then animated to zero, so the eye
  // follows a move instead of a jump. Only transforms are touched, so this stays
  // off the layout/paint path.
  const mediaCardNodesRef = useRef(new Map<string, HTMLDivElement>());
  const mediaCardLeftsRef = useRef(new Map<string, number>());
  // Where the finger let go, so the picked-up card settles from that exact point
  // into its new slot instead of snapping back first.
  const releasedDragRef = useRef<{ id: string; dx: number } | null>(null);

  const registerMediaCard = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) {
      mediaCardNodesRef.current.set(id, node);
    } else {
      mediaCardNodesRef.current.delete(id);
      mediaCardLeftsRef.current.delete(id);
    }
  }, []);

  useLayoutEffect(() => {
    const previousLefts = mediaCardLeftsRef.current;
    const nextLefts = new Map<string, number>();
    // offsetLeft, not getBoundingClientRect: it reports layout position, so the
    // live drag transform and the row's scroll offset cannot skew the baseline.
    mediaCardNodesRef.current.forEach((node, id) => {
      nextLefts.set(id, node.offsetLeft);
    });

    const released = releasedDragRef.current;
    releasedDragRef.current = null;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (previousLefts.size > 0 && !reduceMotion) {
      mediaCardNodesRef.current.forEach((node, id) => {
        const before = previousLefts.get(id);
        const after = nextLefts.get(id);
        if (before === undefined || after === undefined) {
          return;
        }
        // The dragged card starts from where it was released, not from the slot
        // it used to occupy — otherwise it visibly jumps back before animating.
        const delta = before - after + (released?.id === id ? released.dx : 0);
        if (Math.abs(delta) < 1) {
          return;
        }
        // Absent in jsdom and older browsers — the reorder still happens, it
        // just lands instantly rather than animating.
        if (typeof node.animate !== 'function') {
          return;
        }
        node.animate(
          [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
          { duration: 220, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' }
        );
      });
    }

    mediaCardLeftsRef.current = nextLefts;
  }, [mediaPreviewItems]);
  const hasGeneratedProof = Boolean(prefilledGeneration);
  const trimmedBody = body.trim();
  const bodyCount = body.length;
  const titleCount = title.trim().length;
  const hasMediaProof = proofMode === 'media' && (mediaItems.length > 0 || hasGeneratedProof);
  const postFormat: PostFormat = hasMediaProof ? (trimmedBody ? 'mixed' : 'media') : 'text';
  const displayVisibility = visibility;
  const generationPaywallPrefill = prefilledGeneration?.paywallPrefill ?? null;
  const hasGenerationPaywallPrefill = hasUsableGenerationPaywallPrefill(generationPaywallPrefill);
  const shouldFocusPriceInput =
    requestedFocusTarget === 'price' && (isGeneratedPaywallIntent || isCreationPaywallManagementIntent);
  // A bundle a buyer has already paid for is frozen: its access mode, price and
  // contents stay as sold. Visibility edits still flow through.
  const isResourceEditingLocked = Boolean(initialPost?.hasPaidOrders);
  const readyResourceCards = useMemo(
    () => resourceCards.filter((card) => resourceCardHasContent(card)),
    [resourceCards]
  );
  const hasResourceContent = readyResourceCards.length > 0;
  const parsedResourcePriceTokens = Number.parseInt(resourcePriceTokens.trim() || '0', 10);
  const resourcePriceUsdCents = resourceAccessMode === 'paid' && Number.isFinite(parsedResourcePriceTokens)
    ? Math.round(parsedResourcePriceTokens)
    : 0;
  // Clamped rather than guarded at the render site, so an empty or nonsense
  // price reads "You earn ~0 tokens" the way the mobile composer does instead
  // of hiding the split entirely.
  const creatorEarningsTokens = Math.floor(
    Math.max(0, Number.isFinite(parsedResourcePriceTokens) ? parsedResourcePriceTokens : 0) * 0.85 * 100
  ) / 100;
  const suggestedResourcePreview = useMemo(
    () => getResourceCardPreview(readyResourceCards),
    [readyResourceCards]
  );
  /**
   * Each item carries the key it will be submitted with, so a scope points at
   * the media itself rather than its position -- reordering after scoping keeps
   * the resource attached to the same output, and a scope on media added during
   * an edit still names a key the server accepts.
   */
  const resourceScopeMediaOptions = useMemo(
    () => mediaPreviewItems.map((item, index) => ({
      mediaKey: item.mediaKey,
      label: getComposerMediaLabel(index),
      previewUrl: item.previewUrl ?? null,
      mediaKind: item.mediaKind,
    })),
    [mediaPreviewItems]
  );
  const selectedResourceKinds = useMemo(
    () => getPostResourceKinds({ items: buildResourceCardItems(readyResourceCards), allowRemix: resourceAllowRemix }),
    [readyResourceCards, resourceAllowRemix]
  );
  const resourceBundleDraft = useMemo<PostResourceBundleInput | null>(
    () => buildResourceCardBundleInput({
      accessMode: resourceAccessMode,
      cards: resourceCards,
      allowRemix: resourceAllowRemix,
      summary: resourceSummary,
      previewText: resourcePreviewText,
      priceTokens: resourcePriceUsdCents,
    }),
    [
      resourceAccessMode,
      resourceAllowRemix,
      resourceCards,
      resourcePreviewText,
      resourcePriceUsdCents,
      resourceSummary,
    ]
  );
  const resourcePreviewRequiredError = error?.section === 'resources'
    && /add a package preview/i.test(error.message)
      ? error.message
      : null;
  const resourceListingCopyError = error?.section === 'resources'
    && /useful preview or summary/i.test(error.message)
      ? error.message
      : null;
  // Marketplace quality reads a non-empty summary before preview text. Put its
  // feedback beside the field that is actually controlling that decision, so a
  // legacy short/placeholder summary cannot invisibly shadow a valid preview.
  const resourceSummaryError = resourceListingCopyError && resourceSummary.trim()
    ? resourceListingCopyError
    : null;
  const resourcePreviewError = resourcePreviewRequiredError
    ?? (resourceListingCopyError && !resourceSummary.trim() ? resourceListingCopyError : null);
  const publicPostTitle = title.trim() || (trimmedBody ? trimmedBody.split(/[.!?\n]/)[0]?.trim() ?? '' : '');
  const hasTitle = title.trim().length > 0;
  const completionChecklist = [
    {
      label: 'Title added',
      complete: hasTitle,
      detail: hasTitle ? 'Your post is named' : 'Every post needs a title',
    },
    {
      label: 'Proof added',
      complete: hasMediaProof || trimmedBody.length >= 24,
      detail: hasMediaProof ? 'Media is attached' : trimmedBody.length >= 24 ? 'Text proof is ready' : 'Add media or switch to text',
    },
    {
      label: proofMode === 'text' ? 'Story ready' : 'Caption optional',
      complete: proofMode !== 'text' || trimmedBody.length > 0,
      detail: trimmedBody
        ? (proofMode === 'text' ? 'Post body is included' : 'Caption gives viewers context')
        : (proofMode === 'text' ? 'Add a useful visible post' : 'Add context to help this media perform'),
    },
    {
      label: 'Recipe optional',
      complete: resourceAccessMode === 'none' || isResourceEditingLocked || hasResourceContent || resourceAllowRemix,
      detail: resourceAccessMode === 'none'
        ? 'No recipe selected'
        : isResourceEditingLocked
          ? 'Sold package stays as sold'
          : hasResourceContent || resourceAllowRemix ? getLockedSummary(selectedResourceKinds) : 'Add one asset',
    },
  ];
  const stepBadgeLabel = hasGeneratedProof ? 'Generated media attached' : proofMode === 'text' ? 'Text post' : 'Media post';

  useEffect(() => () => {
    for (const item of mediaPreviewItems) {
      if (item.file && item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
      }
    }
  }, [mediaPreviewItems]);

  useEffect(() => {
    // A different generation or entry intent starts a fresh paywall-prefill session.
    setDidApplyGenerationPaywallPrefill(false);
    setDidFocusPriceInput(false);
  }, [generationId, isCreationPaywallManagementIntent, isGeneratedPaywallIntent]);

  useEffect(() => {
    // Applies on both explicit recipe entries: publishing a paid generation and
    // managing an existing creation's recipe. Without the second, opening
    // "Manage recipe" on a post whose bundle has no stored items showed an
    // empty package with none of the generation's prompt or notes prefilled.
    if (
      !(isGeneratedPaywallIntent || isCreationPaywallManagementIntent)
      || didApplyGenerationPaywallPrefill
      || !prefilledGeneration
    ) {
      return;
    }

    const paywallPrefill = prefilledGeneration.paywallPrefill;
    if (!paywallPrefill || !hasUsableGenerationPaywallPrefill(paywallPrefill)) {
      // Mark this generation as inspected even when it has no usable paywall
      // payload — but only once the fetched draft has been seen. The edit-mode
      // seed never carries a prefill, and concluding from it would lock the
      // real one out.
      if (prefilledGeneration.source === 'fetched') {
        setDidApplyGenerationPaywallPrefill(true);
      }
      return;
    }

    // The saved generation seeds the package as cards rather than loose fields,
    // so a prefilled recipe is editable in exactly the same way as a hand-built
    // one.
    setResourceCards((current) => {
      if (current.length > 0) {
        return current;
      }

      const prefilledCards: PostComposerResourceCardDraft[] = [];
      if (paywallPrefill.promptText) {
        prefilledCards.push(createPostComposerResourceCard('prompt', {
          textContent: paywallPrefill.promptText,
        }));
      }
      if (paywallPrefill.notesMarkdown) {
        prefilledCards.push(createPostComposerResourceCard('guide', {
          textContent: paywallPrefill.notesMarkdown,
        }));
      }
      return prefilledCards;
    });

    if (paywallPrefill.resourceKinds.includes('remix')) {
      setResourceAllowRemix(true);
    }

    setDidApplyGenerationPaywallPrefill(true);
  }, [
    didApplyGenerationPaywallPrefill,
    isCreationPaywallManagementIntent,
    isGeneratedPaywallIntent,
    prefilledGeneration,
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
      // Removing the generation route context clears its derived draft data.
      setPrefilledGeneration(null);
      setGenerationError(null);
      return;
    }

    let cancelled = false;

    const loadGeneration = async () => {
      setIsLoadingGeneration(true);
      setGenerationError(null);

      try {
        const generationParams = new URLSearchParams({
          includeArchived: 'true',
          id: generationId,
          limit: '1',
        });
        const response = await fetch(`/api/generations?${generationParams.toString()}`, {
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
          source: 'fetched',
        };

        setPrefilledGeneration(nextGeneration);
        setProofMode('media');
        setCategory(nextGeneration.category);
        // maxLength caps typing, not a programmatic prefill, so trim here too —
        // otherwise a long generation title submits over-limit and the server
        // rejects a post the composer never flagged.
        setTitle((current) => current || nextGeneration.title.slice(0, TITLE_MAX_LENGTH));
        setDescription((current) => current || nextGeneration.description);
      } catch (loadError) {
        if (!cancelled) {
          setGenerationError(loadError instanceof Error ? loadError.message : 'Failed to load generation.');
          // Edit mode seeds a draft for this generation from the server-rendered
          // post; a failed enhancement fetch must not blank it. Only clear data
          // that belongs to a different generation.
          setPrefilledGeneration((current) => (current?.id === generationId ? current : null));
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

  useEffect(() => {
    let cancelled = false;

    void fetch('/api/source-tools')
      .then(async (response) => {
        const payload = await response.json();
        if (!cancelled && Array.isArray(payload.tools)) {
          setSourceToolsData(payload.tools as SourceToolOption[]);
        }
      })
      .catch(() => {
        // Source tools fetch is non-critical; use empty list as fallback.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (prefilledGeneration && madeWithRows.length === 1 && !madeWithRows[0].toolLabel) {
      // A generation-backed post is authored by this product unless the user overrides it.
      setMadeWithRows([{
        id: 'mw-0',
        toolLabel: 'magicbooklet',
        toolSlug: 'magicbooklet',
        modelLabel: prefilledGeneration.model || '',
        modelSlug: prefilledGeneration.model || '',
        createTool: false,
        createModel: false,
      }]);
    }
  }, [prefilledGeneration, madeWithRows]);

  const inferredCategory = useMemo((): PostMediaCategory | null => {
    if (proofMode === 'text') return null;
    if (hasGeneratedProof) return prefilledGeneration?.category ?? 'image';
    return inferCategoryFromContentType(mediaItems[0]?.contentType)
      ?? mediaItems[0]?.mediaKind
      ?? null;
  }, [hasGeneratedProof, mediaItems, prefilledGeneration, proofMode]);

  const sourceToolsForSubmit = useMemo(() => {
    return madeWithRows
      .filter((row) => row.toolLabel.trim())
      .map((row) => {
        const requestedSlug = slugifySourceTool(row.toolSlug);
        const selectedTool = sourceToolsData.find(
          (tool) =>
            (requestedSlug && tool.slug === requestedSlug) ||
            tool.label.toLowerCase() === row.toolLabel.trim().toLowerCase()
        );
        const requestedModelSlug = slugifySourceTool(row.modelSlug);
        const selectedModel = selectedTool?.models.find(
          (model) =>
            (requestedModelSlug && model.slug === requestedModelSlug) ||
            model.label.toLowerCase() === row.modelLabel.trim().toLowerCase()
        );

        return {
          toolLabel: selectedTool?.label ?? row.toolLabel.trim(),
          toolSlug: selectedTool?.slug ?? requestedSlug ?? slugifySourceTool(row.toolLabel),
          modelLabel: selectedModel?.label ?? (row.modelLabel.trim() || null),
          modelSlug: selectedModel?.slug ?? slugifySourceTool(row.modelSlug || row.modelLabel),
          ...(row.createTool ? { createTool: true } : {}),
          ...(row.createModel ? { createModel: true } : {}),
        };
      });
  }, [madeWithRows, sourceToolsData]);

  const primarySourceTool = useMemo(() => {
    if (sourceToolsForSubmit.length === 0) {
      return { label: null, slug: null };
    }
    const first = sourceToolsForSubmit[0];
    return { label: first.toolLabel, slug: first.toolSlug };
  }, [sourceToolsForSubmit]);

  const updateMadeWithRow = (id: string, patch: Partial<MadeWithRow>) => {
    setMadeWithRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    resetFeedback();
  };

  const addMadeWithRow = () => {
    setMadeWithRows((current) => [
      ...current,
      {
        id: `mw-${Date.now()}`,
        toolLabel: '',
        toolSlug: '',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      },
    ]);
    resetFeedback();
  };

  const removeMadeWithRow = (id: string) => {
    setMadeWithRows((current) => {
      const next = current.filter((row) => row.id !== id);
      return next.length > 0 ? next : [{
        id: 'mw-0',
        toolLabel: '',
        toolSlug: '',
        modelLabel: '',
        modelSlug: '',
        createTool: false,
        createModel: false,
      }];
    });
    resetFeedback();
  };

  const submitWithVisibility = (targetVisibility: PostVisibility) => {
    submitVisibilityRef.current = targetVisibility;
    setVisibility(targetVisibility);
    resetFeedback();
  };

  const resetFeedback = () => {
    setCreatedPost(null);
    setError(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  // Every in-flight add-time batch, so publish can wait for all of them — a
  // single "latest batch" ref let a second add overwrite the first, and publish
  // then re-uploaded the still-running batch's files.
  const activeEagerUploadsRef = useRef(new Set<Promise<void>>());
  // Controllers for those batches. Cancel aborts every one of them, not just
  // whichever batch happened to start last.
  const eagerUploadControllersRef = useRef(new Set<AbortController>());
  // Per-batch progress, merged into the one bar — with two batches in flight the
  // numbers must sum rather than fight, and the bar only clears when the last
  // batch is done.
  const eagerProgressRef = useRef(new Map<AbortController, {
    bytesSent: number; totalBytes: number; completed: number; total: number;
  }>());
  // Staged paths keyed by item id. Publish reads this rather than waiting for the
  // setMediaItems above to round-trip through React — resuming from an awaited
  // upload does not guarantee the new state has committed, and reading it too
  // early made publish upload the same file a second time.
  const stagedPathsRef = useRef(new Map<string, string>());

  const publishCombinedEagerProgress = () => {
    const batches = [...eagerProgressRef.current.values()];
    if (batches.length === 0) {
      setUploadProgress(null);
      return;
    }
    const totals = batches.reduce(
      (sum, batch) => ({
        bytesSent: sum.bytesSent + batch.bytesSent,
        totalBytes: sum.totalBytes + batch.totalBytes,
        completed: sum.completed + batch.completed,
        total: sum.total + batch.total,
      }),
      { bytesSent: 0, totalBytes: 0, completed: 0, total: 0 },
    );
    setUploadProgress({
      ...totals,
      percent: totals.totalBytes > 0 ? Math.round((totals.bytesSent / totals.totalBytes) * 100) : 0,
    });
  };

  const uploadAddedMedia = async (added: ComposerMediaItem[]) => {
    const uploadable = added.filter((item) => item.file);
    if (uploadable.length === 0) {
      return;
    }

    const controller = new AbortController();
    eagerUploadControllersRef.current.add(controller);

    const bytesByIndex = new Map<number, { bytesSent: number; totalBytes: number }>();
    let completed = 0;
    const publishAddProgress = () => {
      const totals = [...bytesByIndex.values()].reduce(
        (sum, entry) => ({
          bytesSent: sum.bytesSent + entry.bytesSent,
          totalBytes: sum.totalBytes + entry.totalBytes,
        }),
        { bytesSent: 0, totalBytes: 0 },
      );
      eagerProgressRef.current.set(controller, {
        ...totals,
        completed,
        total: uploadable.length,
      });
      publishCombinedEagerProgress();
    };

    uploadable.forEach((item, index) => {
      bytesByIndex.set(index, { bytesSent: 0, totalBytes: item.file?.size ?? 0 });
    });
    publishAddProgress();

    const run = (async () => {
      try {
        const result = await runWeightedUploadQueue(
          uploadable.map((item) => ({ item, kind: item.mediaKind })),
          async (item, index) => {
            // uploadMediaToTemporaryStorage resolves the session itself and
            // ignores this argument, so there is nothing to look up here.
            const media = await uploadMediaToTemporaryStorage(item.file!, '', {
              signal: controller.signal,
              onProgress: ({ bytesSent, totalBytes }) => {
                bytesByIndex.set(index, { bytesSent, totalBytes });
                publishAddProgress();
              },
            });
            completed += 1;
            publishAddProgress();
            return media.storagePath;
          },
          { signal: controller.signal },
        );

        // Stamping storagePath is what makes publish skip these — the pending
        // filter there already excludes anything that carries one.
        const pathById = new Map<string, string>();
        result.successes.forEach((entry) => {
          pathById.set(entry.item.id, entry.result);
          stagedPathsRef.current.set(entry.item.id, entry.result);
        });
        if (pathById.size > 0) {
          setMediaItems((current) => current.map((item) => (
            pathById.has(item.id) ? { ...item, storagePath: pathById.get(item.id)! } : item
          )));
        }

        // Say so now rather than at publish. Nothing is lost — a failed item
        // keeps its File and publish re-uploads it — but silently pretending the
        // add worked would strand the user until the final click.
        const failures = result.failures.filter((failure) => !isUploadCancelledError(failure.error));
        if (failures.length > 0) {
          const failedNames = failures
            .map((failure) => failure.item.originalName ?? failure.item.file?.name)
            .filter(Boolean)
            .join(', ');
          setError({
            section: 'post',
            message: `${failures.length} of ${uploadable.length} uploads failed${failedNames ? ` (${failedNames})` : ''}. They will be retried when you publish.`,
          });
        }
      } catch {
        // Unexpected throw rather than a per-file failure. Anything not staged
        // keeps its File, so publish re-uploads it and the composer recovers.
      } finally {
        eagerUploadControllersRef.current.delete(controller);
        eagerProgressRef.current.delete(controller);
        // Re-renders the sum of whatever batches remain, or clears the bar when
        // this was the last one.
        publishCombinedEagerProgress();
      }
    })();

    activeEagerUploadsRef.current.add(run);
    try {
      await run;
    } finally {
      activeEagerUploadsRef.current.delete(run);
    }
  };

  const appendMediaFiles = async (files: File[]) => {
    const supportedFiles = files.filter(
      (candidate) => candidate.type.startsWith('image/') || candidate.type.startsWith('video/')
    );
    if (supportedFiles.length === 0) {
      return;
    }

    // Refuse what the browser can measure before any bytes upload: size is
    // synchronous, duration comes from a metadata-only load. An unreadable
    // duration passes — the publish check and the rendition sweep's probe of
    // the actual file are the layers equipped to judge those.
    const rejections: string[] = [];
    const admitted: Array<{ file: File; durationSeconds: number | null }> = [];
    for (const candidate of supportedFiles) {
      if (!candidate.type.startsWith('video/')) {
        admitted.push({ file: candidate, durationSeconds: null });
        continue;
      }
      if (candidate.size > POST_VIDEO_MAX_UPLOAD_BYTES) {
        if (!rejections.includes(POST_VIDEO_UPLOAD_BYTES_MESSAGE)) rejections.push(POST_VIDEO_UPLOAD_BYTES_MESSAGE);
        continue;
      }
      const durationSeconds = await readVideoFileDurationSeconds(candidate);
      if (durationSeconds !== null && durationSeconds > POST_VIDEO_MAX_DURATION_SECONDS) {
        if (!rejections.includes(POST_VIDEO_DURATION_LIMIT_MESSAGE)) rejections.push(POST_VIDEO_DURATION_LIMIT_MESSAGE);
        continue;
      }
      // The measured value rides along to publish so the server can reject
      // over-ceiling reports early and seed duration_seconds.
      admitted.push({ file: candidate, durationSeconds });
    }

    // Computed from the render snapshot, not inside the updater: updaters must
    // stay pure (Strict Mode replays them, and collecting into an outer array
    // from one is exactly the impurity that replay duplicates). Appends only
    // arrive from discrete user events, so the snapshot is always current; the
    // slice inside the updater is a pure re-cap in case it ever is not.
    const accepted = admitted
      .slice(0, Math.max(0, 5 - mediaItems.length))
      .map((candidate, index) =>
        createComposerMediaItem(candidate.file, mediaItems.length + index, candidate.durationSeconds));
    if (accepted.length === 0) {
      if (rejections.length > 0) setError({ section: 'post', message: rejections.join(' ') });
      return;
    }

    setMediaItems((current) => [...current, ...accepted].slice(0, 5));
    resetFeedback();

    // Upload as soon as the files are chosen, the way the mobile composer does,
    // so the wait is spent here with a progress bar rather than silently at
    // publish. Failures are deliberately non-blocking: the item keeps its File,
    // so the publish flow still uploads anything that did not make it.
    void uploadAddedMedia(accepted);

    // After resetFeedback, so a partial rejection is still visible next to the
    // files that did make it in.
    if (rejections.length > 0) setError({ section: 'post', message: rejections.join(' ') });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    void appendMediaFiles(Array.from(e.dataTransfer.files ?? []));
  };

  const handleMiddleClick = () => {
    mediaInputRef.current?.click();
  };

  const removeMediaItem = (id: string) => {
    // Read from the render snapshot rather than inside the updater: a scope
    // left pointing at removed media fails validation on publish, and with one
    // output left the scope picker is hidden, so it could not be cleared by hand.
    const removed = mediaItems.find((item) => item.id === id);
    setMediaItems((current) => current.filter((item) => item.id !== id));
    if (removed) {
      setResourceCards((current) => current.map((card) => {
        if (!card.mediaKeys.includes(removed.mediaKey)) {
          return card;
        }
        const mediaKeys = card.mediaKeys.filter((key) => key !== removed.mediaKey);
        return { ...card, mediaKeys, appliesToAll: card.appliesToAll || mediaKeys.length === 0 };
      }));
    }
    resetFeedback();
  };

  const switchToTextProof = () => {
    setProofMode('text');
    setMediaItems([]);
    // With no proof media left, every resource necessarily applies to the post
    // as a whole. Clearing all keys here mirrors removing the media one by one
    // and prevents an invisible, stale scope from failing publish validation.
    setResourceCards((current) => current.map((card) => (
      card.mediaKeys.length > 0 || !card.appliesToAll
        ? { ...card, appliesToAll: true, mediaKeys: [] }
        : card
    )));
    resetFeedback();
  };

  const moveMediaItem = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      return;
    }

    setMediaItems((current) => {
      const sourceIndex = current.findIndex((item) => item.id === sourceId);
      const targetIndex = current.findIndex((item) => item.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    resetFeedback();
  };

  // Pointer-driven reorder, mirroring the mobile composer: the card is picked up
  // and follows the pointer, then lands in whichever slot it travelled to. The
  // offset is written straight to the node rather than held in state — this
  // component renders a very large tree, and re-rendering it per pointermove
  // would drop frames for a purely visual translation.
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const dragArmedRef = useRef(false);
  const dragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);
  const dragDxRef = useRef(0);

  // Every pointer that lands on a card body starts out as a tap, which opens the
  // preview on release. It stops being one the moment it travels past the slop
  // or the touch hold arms a pick-up, so scrolling and carrying stay silent.
  const mediaTapCandidateRef = useRef(false);
  const tapOriginRef = useRef<{ x: number; y: number } | null>(null);
  const [previewMediaIndex, setPreviewMediaIndex] = useState<number | null>(null);

  const clearMediaDragTimer = () => {
    if (dragTimerRef.current) {
      clearTimeout(dragTimerRef.current);
      dragTimerRef.current = null;
    }
  };

  const resetMediaDrag = () => {
    clearMediaDragTimer();
    if (dragNodeRef.current) {
      dragNodeRef.current.style.transform = '';
    }
    dragArmedRef.current = false;
    dragOriginRef.current = null;
    dragNodeRef.current = null;
    dragDxRef.current = 0;
    mediaTapCandidateRef.current = false;
    tapOriginRef.current = null;
    setDraggedMediaId(null);
  };

  useEffect(() => () => clearMediaDragTimer(), []);

  const armMediaDrag = (node: HTMLDivElement, pointerId: number, id: string) => {
    dragArmedRef.current = true;
    dragNodeRef.current = node;
    setDraggedMediaId(id);
    // Keeps the drag alive once the pointer leaves the card's own bounds.
    if (node.isConnected && node.hasPointerCapture?.(pointerId) === false) {
      node.setPointerCapture(pointerId);
    }
  };

  const handleMediaPointerDown = (event: React.PointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0) {
      return;
    }
    // Remove, the arrow nudges and the expand control live inside the card.
    // Capturing the pointer for them would swallow their click and make the card
    // lift on a plain button press.
    if ((event.target as HTMLElement).closest('button')) {
      return;
    }

    // Armed before the reorder guard below, because a lone media item has nothing
    // to reorder but must still open its preview on tap.
    mediaTapCandidateRef.current = true;
    tapOriginRef.current = { x: event.clientX, y: event.clientY };

    if (mediaPreviewItems.length < 2) {
      return;
    }

    dragOriginRef.current = { x: event.clientX, y: event.clientY };
    dragDxRef.current = 0;

    // A mouse has no scrolling gesture to compete with, and the grip handle
    // already says "drag me", so it picks up on contact. Touch has to hold —
    // otherwise the row could never be scrolled past its first card.
    if (event.pointerType !== 'touch') {
      armMediaDrag(event.currentTarget, event.pointerId, id);
      return;
    }

    const node = event.currentTarget;
    const { pointerId } = event;
    clearMediaDragTimer();
    dragTimerRef.current = setTimeout(() => {
      // The hold completed, so this is a deliberate pick-up: releasing in place
      // should settle the card rather than pop a preview open.
      mediaTapCandidateRef.current = false;
      armMediaDrag(node, pointerId, id);
    }, MEDIA_DRAG_HOLD_MS);
  };

  const handleMediaPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    // Checked ahead of the drag origin, which a single-item strip never sets.
    const tapOrigin = tapOriginRef.current;
    if (
      tapOrigin
      && (Math.abs(event.clientX - tapOrigin.x) > MEDIA_DRAG_SLOP
        || Math.abs(event.clientY - tapOrigin.y) > MEDIA_DRAG_SLOP)
    ) {
      // Travelled too far to be a tap — this is a scroll or a carry.
      mediaTapCandidateRef.current = false;
    }

    const origin = dragOriginRef.current;
    if (!origin) {
      return;
    }

    const dx = event.clientX - origin.x;
    if (!dragArmedRef.current) {
      // Moving before the hold completes is a scroll, not a pick-up.
      if (Math.abs(dx) > MEDIA_DRAG_SLOP || Math.abs(event.clientY - origin.y) > MEDIA_DRAG_SLOP) {
        clearMediaDragTimer();
        dragOriginRef.current = null;
      }
      return;
    }

    dragDxRef.current = dx;
    if (dragNodeRef.current) {
      dragNodeRef.current.style.transform = `translateX(${dx}px)`;
    }
  };

  const handleMediaPointerUp = (id: string, index: number) => {
    // Read before resetMediaDrag clears it.
    const wasTap = mediaTapCandidateRef.current;

    if (!dragArmedRef.current) {
      resetMediaDrag();
      if (wasTap) {
        setPreviewMediaIndex(index);
      }
      return;
    }

    const dx = dragDxRef.current;
    const slotDelta = Math.round(dx / MEDIA_CARD_STEP);
    const targetIndex = Math.max(0, Math.min(index + slotDelta, mediaPreviewItems.length - 1));
    const targetId = mediaPreviewItems[targetIndex]?.id;
    resetMediaDrag();

    if (slotDelta === 0 || !targetId || targetId === id) {
      if (wasTap) {
        setPreviewMediaIndex(index);
      }
      return;
    }

    releasedDragRef.current = { id, dx };
    moveMediaItem(id, targetId);
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

  /**
   * Upload every not-yet-staged media item, reporting aggregate byte progress.
   *
   * Runs through the weighted queue rather than `Promise.all` so one failure
   * cannot discard files that already uploaded. Items keep their composer order
   * because the first one is the Showcase cover.
   */
  const uploadComposerMedia = async (items: ComposerMediaItem[], ownerUserId: string) => {
    // Items that already carry a storagePath were staged by an earlier publish
    // attempt that failed on a sibling -- re-uploading them would duplicate the
    // staged object and burn the sign rate limit for nothing.
    const pending = items.filter((item) => !item.existingId && !item.storagePath);
    // Media already on the post deliberately sends no mediaKey: the server
    // derives the stored one, and submitting a key it disagrees with is a hard
    // error. New media sends the key its scopes already point at.
    const describeItem = (item: ComposerMediaItem) => {
      if (item.existingId) {
        return { existingId: item.existingId };
      }
      if (item.storagePath) {
        return {
          mediaKey: item.mediaKey,
          storagePath: item.storagePath,
          contentType: item.contentType ?? item.file?.type ?? '',
          originalName: item.originalName ?? item.file?.name ?? '',
          ...(item.durationSeconds != null ? { durationSeconds: item.durationSeconds } : {}),
        };
      }
      return null;
    };

    if (pending.length === 0) {
      return items.map((item) => {
        const described = describeItem(item);
        if (!described) {
          throw new Error('A selected media item is no longer available.');
        }
        return described;
      });
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;

    const bytesByIndex = new Map<number, { bytesSent: number; totalBytes: number }>();
    let completed = 0;
    const publishProgress = () => {
      const totals = [...bytesByIndex.values()].reduce(
        (sum, entry) => ({
          bytesSent: sum.bytesSent + entry.bytesSent,
          totalBytes: sum.totalBytes + entry.totalBytes,
        }),
        { bytesSent: 0, totalBytes: 0 },
      );
      setUploadProgress({
        ...totals,
        completed,
        total: pending.length,
        percent: totals.totalBytes > 0 ? Math.round((totals.bytesSent / totals.totalBytes) * 100) : 0,
      });
    };

    pending.forEach((item, index) => {
      bytesByIndex.set(index, { bytesSent: 0, totalBytes: item.file?.size ?? 0 });
    });
    publishProgress();

    try {
      const uploaded = await runWeightedUploadQueue(
        pending.map((item) => ({ item, kind: item.mediaKind })),
        async (item, index) => {
          if (!item.file) {
            throw new Error('A selected media item is no longer available.');
          }

          const media = await uploadMediaToTemporaryStorage(item.file, ownerUserId, {
            signal: controller.signal,
            onProgress: ({ bytesSent, totalBytes }) => {
              bytesByIndex.set(index, { bytesSent, totalBytes });
              publishProgress();
            },
          });

          completed += 1;
          publishProgress();
          return {
            storagePath: media.storagePath,
            contentType: item.file.type,
            originalName: item.file.name,
          };
        },
        { signal: controller.signal },
      );

      const byItemId = new Map(uploaded.successes.map((entry) => [entry.item.id, entry.result]));

      // Record what made it up BEFORE deciding whether to throw. This is what
      // turns "publish again" into a retry of only the failures instead of a
      // full re-upload that duplicates already-staged objects.
      if (byItemId.size > 0) {
        setMediaItems((current) => current.map((item) => {
          const result = byItemId.get(item.id);
          return result ? { ...item, storagePath: result.storagePath } : item;
        }));
      }

      if (uploaded.failures.length > 0) {
        const cancelled = uploaded.failures.every((failure) => isUploadCancelledError(failure.error));
        if (cancelled) {
          throw new ComposerSubmissionError('Upload cancelled.', 'publish');
        }

        const firstError = uploaded.failures.find((failure) => !isUploadCancelledError(failure.error))?.error;
        const failedNames = uploaded.failures
          .map((failure) => failure.item.originalName ?? failure.item.file?.name)
          .filter(Boolean)
          .join(', ');
        throw new ComposerSubmissionError(
          `${uploaded.failures.length} of ${pending.length} uploads failed${failedNames ? ` (${failedNames})` : ''}. ${
            firstError instanceof Error ? firstError.message : 'Publish again to retry just those files.'
          }`,
          'publish',
        );
      }

      return items.map((item) => {
        const described = describeItem(item);
        if (described) {
          return described;
        }

        const result = byItemId.get(item.id);
        if (!result) {
          throw new Error('A selected media item is no longer available.');
        }
        return { mediaKey: item.mediaKey, ...result };
      });
    } finally {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
      }
      setUploadProgress(null);
    }
  };

  const cancelMediaUpload = () => {
    // Publish-time uploads and every in-flight add-time batch — cancelling only
    // the most recent batch left older ones running with no way to stop them.
    uploadAbortRef.current?.abort();
    eagerUploadControllersRef.current.forEach((controller) => controller.abort());
  };

  /**
   * Forget staged paths after the server has been asked to publish and failed.
   *
   * Every server-side publish failure runs `cleanupUploadedMedia`, which deletes
   * the staged objects the composer is still holding paths to. Keeping them
   * would make the retry skip re-uploading and fail forever on
   * "Failed to load uploaded media" -- so paths survive a client-side upload
   * failure (the point of retrying only what failed) but never a dispatched one.
   */
  const forgetStagedMediaPaths = () => {
    // The add-time cache has to go too, or publish would re-apply the very paths
    // the server just deleted and the retry could never recover.
    stagedPathsRef.current.clear();
    setMediaItems((current) => current.map((item) => (
      item.storagePath ? { ...item, storagePath: null } : item
    )));
  };

  const stopWithError = (
    message: string,
    section: 'post' | 'story' | 'resources' | 'publish',
    action?: { href: string; label: string }
  ) => {
    setError({ section, message, actionHref: action?.href, actionLabel: action?.label });
    focusComposerSection(section);
  };

  const renderSectionError = (section: ComposerError['section']) => {
    if (!error || error.section !== section) {
      return null;
    }

    return (
      <div role="alert" className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
        <p>{error.message}</p>
        {error.actionHref ? (
          <Link
            href={error.actionHref}
            target="_blank"
            rel="noopener noreferrer"
            className="ui-focus-ring mt-2 inline-flex min-h-12 items-center font-bold text-white underline decoration-white/40 underline-offset-4"
          >
            {error.actionLabel ?? 'Complete profile in a new tab'}
          </Link>
        ) : null}
      </div>
    );
  };

  const openResourceTypePicker = () => {
    setEditingResourceCard(null);
    setIsChoosingResourceType(true);
    resetFeedback();
  };

  const chooseResourceCardType = (type: PostComposerResourceCardType) => {
    setIsChoosingResourceType(false);
    setEditingResourceCard(createPostComposerResourceCard(type));
  };

  const editResourceCard = (id: string) => {
    const card = resourceCards.find((candidate) => candidate.id === id);
    if (!card) {
      return;
    }
    setIsChoosingResourceType(false);
    setEditingResourceCard({ ...card });
    resetFeedback();
  };

  // Edits stay on a private copy until Save, so abandoning the editor cannot
  // half-apply a change to the package.
  const updateEditingResourceCard = (patch: Partial<PostComposerResourceCardDraft>) => {
    setEditingResourceCard((current) => current ? { ...current, ...patch } : current);
  };

  const closeResourceEditor = () => {
    setEditingResourceCard(null);
    setIsChoosingResourceType(false);
  };

  const saveResourceCard = () => {
    const card = editingResourceCard;
    if (!card) {
      return;
    }

    setResourceCards((current) => (current.some((candidate) => candidate.id === card.id)
      ? current.map((candidate) => candidate.id === card.id ? card : candidate)
      : [...current, card]));
    closeResourceEditor();
    resetFeedback();
  };

  const removeResourceCard = (id: string) => {
    const nextCards = resourceCards.filter((card) => card.id !== id);
    setResourceCards(nextCards);
    // Removing the final content card is an explicit request to remove the
    // package. Keep remix-only packages alive, but do not leave the form in a
    // paid/free mode that cannot be submitted without a second hidden action.
    if (nextCards.length === 0 && !resourceAllowRemix) {
      setResourceAccessMode('none');
    }
    resetFeedback();
  };

  const uploadResourceCardFile = async (
    file: File,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: SignedUrlUploadProgress) => void;
    },
  ) => {
    if (!session?.access_token) {
      throw new Error('Sign in again to upload resource files.');
    }
    return uploadResourceFile(file, session.access_token, options);
  };


  const completePublish = (nextPost: CreatedPostState, options: { redirect?: boolean } = {}) => {
    setCreatedPost(nextPost);
    trackProductEvent(isEditMode ? 'post_update_success' : 'post_publish_success', {
      visibility: nextPost.visibility,
      recipe_access: nextPost.resourceAccessMode,
      entry_surface: entrySurface ?? 'direct',
    });

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

    const effectiveVisibility = submitVisibilityRef.current;
    trackProductEvent(isEditMode ? 'post_update_attempt' : 'post_publish_attempt', {
      visibility: effectiveVisibility,
      recipe_access: resourceAccessMode,
      proof_mode: proofMode,
      entry_surface: entrySurface ?? 'direct',
    });

    if (!session?.access_token) {
      router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath('/post/new'))}`);
      return;
    }

    if (!hasTitle) {
      stopWithError('Add a title for your post.', 'post');
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

    if (mediaItems.some((item) => item.contentType?.startsWith('audio/'))) {
      stopWithError('Audio posts are not supported in Showcase yet.', 'post');
      return;
    }

    if (bodyCount > BODY_MAX_LENGTH) {
      stopWithError(`Story posts are limited to ${BODY_MAX_LENGTH} characters.`, 'story');
      return;
    }

    // No client-side title-length gate on purpose. The input is capped at
    // TITLE_MAX_LENGTH, so typing or pasting can never exceed it; the only way
    // an over-limit title reaches here is an older post loaded into the editor,
    // and the server deliberately grandfathers those. Blocking here would be
    // wrong in exactly the one case it could ever fire.

    if (effectiveVisibility === 'public') {
      const publicPostQualityError = getPublicPostQualityError({
        title: publicPostTitle,
        body: trimmedBody,
        hasMedia: hasMediaProof,
      });
      if (publicPostQualityError) {
        stopWithError(publicPostQualityError, 'story');
        return;
      }
    }

    let resourceBundle: PostResourceBundleInput | undefined;
    // A sold package is never sent (see the update payload below), so validating
    // it would only block edits to everything else on the post -- a sold bundle
    // that grants remix and nothing else has no cards to satisfy these checks.
    if (resourceAccessMode !== 'none' && !isResourceEditingLocked) {
      if (selectedResourceKinds.length === 0) {
        stopWithError('Choose at least one item to include in the recipe.', 'resources');
        return;
      }

      if (
        resourceAccessMode === 'paid'
        && (
          !Number.isFinite(parsedResourcePriceTokens)
          || parsedResourcePriceTokens < POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS
          || parsedResourcePriceTokens % POST_RESOURCE_PRICE_INCREMENT_USD_CENTS !== 0
        )
      ) {
        stopWithError(
          `Paid unlocks start at ${POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS} tokens and go up in ${POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}-token steps.`,
          'resources',
        );
        return;
      }

      if (!hasResourceContent && !resourceAllowRemix) {
        stopWithError('Add content for at least one selected recipe item before publishing.', 'resources');
        return;
      }

      // The package preview is required buyer-facing copy, so it is the
      // author's to write rather than a generated line.
      if (!resourcePreviewText.trim()) {
        stopWithError('Add a package preview so buyers know what they receive.', 'resources');
        return;
      }

      const shouldRunSubmittedMarketplaceQuality = effectiveVisibility === 'public';
      const submittedMarketplaceAssessment = resourceBundleDraft && shouldRunSubmittedMarketplaceQuality
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
          })
        : { eligible: true, issues: [] };

      if (!submittedMarketplaceAssessment.eligible) {
        const firstIssue = submittedMarketplaceAssessment.issues[0];
        stopWithError(`Improve this recipe before publishing: ${firstIssue?.message ?? 'Finish the marketplace checklist.'}`, firstIssue?.field === 'post' || firstIssue?.field === 'title' ? 'story' : 'resources');
        return;
      }

      resourceBundle = resourceBundleDraft ?? undefined;
    }

    try {
      setIsSubmitting(true);
      // An add-time upload may still be running. Letting it finish means its
      // storagePath is already stamped, so publish skips that file instead of
      // uploading it a second time.
      // Loop, not a single await: a new batch can start while an earlier one is
      // being awaited, and publish must not proceed until every one has settled.
      while (activeEagerUploadsRef.current.size > 0) {
        await Promise.all([...activeEagerUploadsRef.current]);
      }
      const itemsWithStagedPaths = mediaItems.map((item) => (
        !item.storagePath && stagedPathsRef.current.has(item.id)
          ? { ...item, storagePath: stagedPathsRef.current.get(item.id)! }
          : item
      ));
      const mediaItemsForSubmit = generationId
        ? undefined
        : await uploadComposerMedia(itemsWithStagedPaths, session.user.id);

      // The publish route creates a post from a creation. Once the post
      // exists, every edit — including one made from a creation — goes
      // through the post route like any other post: it accepts the owner's
      // fields for a generation-backed post, keeps the creation's media in
      // step, and patches rather than rewrites the row.
      if (generationId && !isEditMode) {
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
            category: inferredCategory ?? undefined,
            sourceTools: sourceToolsForSubmit.length > 0 ? sourceToolsForSubmit : undefined,
            // A missing bundle key means "preserve what is stored". Sending
            // accessMode:none for a sold generation-backed post would retire
            // its live package during an unrelated caption/visibility edit.
            ...(isResourceEditingLocked
              ? {}
              : { resourceBundle: resourceBundle ?? { accessMode: 'none' } }),
          }),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw getSubmissionError(data, 'Failed to publish post.');
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
            sourceTools: sourceToolsForSubmit.length > 0 ? sourceToolsForSubmit : undefined,
            visibility: effectiveVisibility,
            category: inferredCategory ?? undefined,
            mediaItems: mediaItemsForSubmit,
            // A sold package is frozen, and the update path treats an absent
            // key as "keep what is stored" — sending `{accessMode:'none'}` here
            // would delete a bundle people have already paid for.
            ...(isResourceEditingLocked
              ? {}
              : { resourceBundle: resourceBundle ?? { accessMode: 'none' } }),
          }),
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
          throw getSubmissionError(data, 'Failed to save post.');
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
      if (primarySourceTool.label) {
        formData.set('sourceTool', primarySourceTool.label);
      }
      if (primarySourceTool.slug) {
        formData.set('sourceToolSlug', primarySourceTool.slug);
      }
      if (sourceToolsForSubmit.length > 0) {
        formData.set('sourceTools', JSON.stringify(sourceToolsForSubmit));
      }
      formData.set('visibility', effectiveVisibility);
      formData.set('postFormat', postFormat);
      formData.set('resourceBundle', JSON.stringify(resourceBundle ?? { accessMode: 'none' }));

      if (hasMediaProof && mediaItemsForSubmit?.length) {
        formData.set('mediaItems', JSON.stringify(mediaItemsForSubmit));
        formData.set('category', inferredCategory ?? 'image');
      } else if (proofMode === 'text') {
        formData.set('category', 'text');
      }

      let response: Response;
      try {
        response = await fetch('/api/posts', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          body: formData,
        });
      } catch (networkError) {
        // The request may have reached the server and rolled back its staged
        // media, so the safe assumption is that the paths are gone.
        forgetStagedMediaPaths();
        throw networkError;
      }
      const data = await response.json();

      if (!response.ok) {
        forgetStagedMediaPaths();
        throw getSubmissionError(data, 'Failed to publish post.');
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
      trackProductEvent(isEditMode ? 'post_update_failed' : 'post_publish_failed', {
        visibility: effectiveVisibility,
        recipe_access: resourceAccessMode,
        error_section: submitError instanceof ComposerSubmissionError ? submitError.section : 'publish',
      });
      setError({
        section: submitError instanceof ComposerSubmissionError ? submitError.section : 'publish',
        message: submitError instanceof Error ? submitError.message : 'Failed to publish post.',
        actionHref: submitError instanceof ComposerSubmissionError ? submitError.actionHref : undefined,
        actionLabel: submitError instanceof ComposerSubmissionError ? submitError.actionLabel : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const createdPostHasResources = createdPost ? createdPost.resourceAccessMode !== 'none' : false;
  const primaryPostPath = createdPost?.showcasePath ?? createdPost?.ownerPath ?? null;
  const primaryPostLabel = createdPost?.resourceBundleStatus === 'draft'
    ? 'Continue editing'
    : createdPost?.showcasePath
      ? 'View post'
      : 'Open editor';
  const isEditingUnlisted = isEditMode && displayVisibility === 'unlisted';
  const fallbackBackHref = isEditMode || entrySurface === 'creations'
    ? '/creations?view=posts'
    : entrySurface === 'profile'
      ? '/profile?tab=posts'
      : entrySurface === 'marketplace'
        ? '/marketplace'
        : entrySurface === 'seller'
          ? '/marketplace/sell'
          : entrySurface === 'home'
            ? '/'
            : '/showcase';
  const backHref = getSafeInternalReturnPath(searchParams.get('returnTo'), fallbackBackHref);
  const backLabel = isEditMode || entrySurface === 'creations'
    ? 'Back to studio'
    : entrySurface === 'profile'
      ? 'Back to profile'
      : entrySurface === 'marketplace'
        ? 'Back to marketplace'
        : entrySurface === 'seller'
          ? 'Back to seller dashboard'
          : entrySurface === 'home'
            ? 'Back to home'
            : 'Back to showcase';

  return (
    <div className="ui-page ui-page-ambient min-h-screen">
      <div className="fixed inset-0 hidden pointer-events-none">
        <div className="absolute left-[-10%] top-[-8%] h-[40%] w-[32%] rounded-full bg-sky-500/12 blur-[140px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[36%] w-[30%] rounded-full bg-emerald-500/10 blur-[160px]" />
      </div>

      {!createdPost ? (
        <div className="fixed inset-x-4 bottom-4 z-40 lg:hidden">
          {isEditingUnlisted ? (
            <div className="flex items-center justify-between gap-3 rounded-[24px] border border-white/10 bg-zinc-950/95 p-3 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                  Unlisted post
                </div>
                <div className="mt-1 truncate text-sm font-semibold text-white">
                  Shareable by link only
                </div>
              </div>
              <button
                type="submit"
                form="post-composer-form"
                disabled={isSubmitting || isLoadingGeneration}
                onClick={() => submitWithVisibility('unlisted')}
                className="ui-focus-ring inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save unlisted
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-[24px] border border-white/10 bg-zinc-950/95 p-3 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
              <button
                type="submit"
                form="post-composer-form"
                disabled={isSubmitting || isLoadingGeneration}
                onClick={() => submitWithVisibility('private')}
                className="inline-flex flex-1 shrink-0 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save private
              </button>
              <button
                type="submit"
                form="post-composer-form"
                disabled={isSubmitting || isLoadingGeneration}
                onClick={() => submitWithVisibility('public')}
                className="ui-focus-ring inline-flex min-h-12 flex-1 shrink-0 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgePlus className="h-4 w-4" />}
                Publish public
              </button>
            </div>
          )}
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
                  ? 'Manage the recipe behind this post'
                  : isEditMode
                    ? 'Update post'
                    : 'Create post'}
              </h1>
              <p className="mt-2 text-sm text-zinc-400">
                {isCreationPaywallManagementIntent
                  ? 'Adjust post settings, pricing, and visibility below.'
                  : isGeneratedPaywallIntent
                    ? 'Your media is attached. Complete the optional recipe details below.'
                    : isEditMode
                      ? 'Edit post content, visibility, and recipe settings.'
                      : 'Share your work and add an optional reusable recipe.'}
              </p>
            </div>

            <form id="post-composer-form" ref={formRef} className="space-y-6 pb-28 lg:pb-0" onSubmit={handleSubmit}>
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
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                      Title <span className="text-sky-300">Required</span>
                    </span>
                    {/* aria-hidden so the input's accessible name stays "Title, maximum N
                        characters" instead of churning on every keystroke; the limit itself
                        is announced once via aria-label. */}
                    <span
                      aria-hidden="true"
                      className={`text-xs ${titleCount > TITLE_MAX_LENGTH ? 'text-rose-300' : 'text-zinc-500'}`}
                    >
                      {titleCount}/{TITLE_MAX_LENGTH}
                    </span>
                  </div>
                  <input
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      resetFeedback();
                    }}
                    maxLength={TITLE_MAX_LENGTH}
                    aria-label={`Title, required, maximum ${TITLE_MAX_LENGTH} characters`}
                    aria-required="true"
                    placeholder="Give your post a title"
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {proofMode === 'media' ? (
                  <div className="mt-5 rounded-[24px] border border-sky-300/15 bg-sky-400/5 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-100/75">Made With</div>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                          Add the tool and model you used.{hasGeneratedProof ? ' magicbooklet is already set.' : ''}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-zinc-500">
                          Popular tools appear first. Search to find more editors, workflows, API platforms, or older tools.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 space-y-3">
                      {madeWithRows.map((row, index) => {
                        const selectedTool = sourceToolsData.find((t) =>
                          row.toolSlug ? t.slug === row.toolSlug : t.label === row.toolLabel
                        );
                        const provisionalToolRows = madeWithRows.filter((candidate) => candidate.createTool);
                        const toolOptions: CreatableComboboxOption[] = [
                          ...sourceToolsData.map((tool) => ({
                            value: tool.slug,
                            label: tool.label,
                            keywords: [
                              ...(tool.aliases ?? []),
                              tool.toolType ?? 'platform',
                              ...(tool.capabilities ?? []),
                              tool.providerSlug ?? '',
                            ],
                            meta: tool.status && tool.status !== 'current'
                              ? 'Historical'
                              : tool.toolType === 'api-marketplace'
                                ? 'API platform'
                                : tool.toolType === 'editor'
                                  ? 'Editor'
                                  : tool.toolType === 'workflow'
                                    ? 'Workflow'
                                    : 'AI platform',
                            hiddenUntilSearch: Boolean(
                              (tool.catalogTier && tool.catalogTier !== 'featured')
                              || (tool.status && tool.status !== 'current')
                            ),
                          })),
                          ...provisionalToolRows
                            .filter((candidate, candidateIndex, candidates) => (
                              candidates.findIndex((item) => item.toolSlug === candidate.toolSlug) === candidateIndex
                              && !sourceToolsData.some((tool) => tool.slug === candidate.toolSlug)
                            ))
                            .map((candidate) => ({
                              value: candidate.toolSlug,
                              label: candidate.toolLabel,
                              provisional: true,
                            })),
                        ];
                        const catalogModels = selectedTool?.models ?? [];
                        const provisionalModelRows = madeWithRows.filter((candidate) => (
                          candidate.toolSlug === row.toolSlug
                          && candidate.createModel
                          && candidate.modelLabel
                        ));
                        const modelOptions: CreatableComboboxOption[] = [
                          ...catalogModels.map((model) => ({
                            value: model.slug,
                            label: model.label,
                            keywords: [
                              ...(model.aliases ?? []),
                              ...(model.capabilities ?? []),
                              model.providerSlug ?? '',
                            ],
                            meta: model.status && model.status !== 'current' ? 'Historical' : undefined,
                            hiddenUntilSearch: Boolean(model.status && model.status !== 'current'),
                          })),
                          ...provisionalModelRows
                            .filter((candidate, candidateIndex, candidates) => (
                              candidates.findIndex((item) => item.modelSlug === candidate.modelSlug) === candidateIndex
                              && !catalogModels.some((model) => model.slug === candidate.modelSlug)
                            ))
                            .map((candidate) => ({
                              value: candidate.modelSlug,
                              label: candidate.modelLabel,
                              provisional: true,
                            })),
                        ];
                        const toolIsCatalogEntry = Boolean(selectedTool);
                        const modelIsCatalogEntry = Boolean(catalogModels.some((model) => model.slug === row.modelSlug));

                        return (
                          <div key={row.id} className="flex flex-wrap items-center gap-2">
                            <CreatableCombobox
                              ariaLabel={`Tool ${index + 1}`}
                              value={row.toolLabel}
                              options={toolOptions}
                              placeholder="Choose or search tool"
                              disabled={hasGeneratedProof}
                              allowCustomEdit={!toolIsCatalogEntry && !row.createTool}
                              onSelect={(option) => {
                                if (!option) {
                                  updateMadeWithRow(row.id, {
                                    toolLabel: '',
                                    toolSlug: '',
                                    modelLabel: '',
                                    modelSlug: '',
                                    createTool: false,
                                    createModel: false,
                                  });
                                  return;
                                }
                                updateMadeWithRow(row.id, {
                                  toolLabel: option.label,
                                  toolSlug: option.value,
                                  modelLabel: '',
                                  modelSlug: '',
                                  createTool: option.provisional === true,
                                  createModel: false,
                                });
                              }}
                              onCreate={(label) => {
                                updateMadeWithRow(row.id, {
                                  toolLabel: label,
                                  toolSlug: slugifySourceTool(label) ?? '',
                                  modelLabel: '',
                                  modelSlug: '',
                                  createTool: true,
                                  createModel: false,
                                });
                              }}
                              onCustomEdit={(label) => {
                                updateMadeWithRow(row.id, {
                                  toolLabel: label,
                                  toolSlug: slugifySourceTool(label) ?? '',
                                  createTool: false,
                                });
                              }}
                            />
                            <CreatableCombobox
                              ariaLabel={`Model for ${row.toolLabel || `tool ${index + 1}`}`}
                              value={row.modelLabel}
                              options={modelOptions}
                              placeholder="Any model"
                              emptyOptionLabel="Any model"
                              disabled={hasGeneratedProof || !row.toolLabel}
                              allowCustomEdit={Boolean(row.modelLabel && !modelIsCatalogEntry && !row.createModel)}
                              onSelect={(option) => {
                                updateMadeWithRow(row.id, {
                                  modelLabel: option?.label ?? '',
                                  modelSlug: option?.value ?? '',
                                  createModel: option?.provisional === true,
                                });
                              }}
                              onCreate={(label) => {
                                updateMadeWithRow(row.id, {
                                  modelLabel: label,
                                  modelSlug: slugifySourceTool(label) ?? '',
                                  createModel: true,
                                });
                              }}
                              onCustomEdit={(label) => {
                                updateMadeWithRow(row.id, {
                                  modelLabel: label,
                                  modelSlug: slugifySourceTool(label) ?? '',
                                  createModel: false,
                                });
                              }}
                            />
                            {!hasGeneratedProof && madeWithRows.length > 1 ? (
                              <button
                                type="button"
                                onClick={() => removeMadeWithRow(row.id)}
                                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                                aria-label={`Remove tool ${index + 1}`}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                      {!hasGeneratedProof && madeWithRows.length < 5 ? (
                        <button
                          type="button"
                          onClick={addMadeWithRow}
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                        >
                          <Plus className="h-4 w-4" />
                          Add another tool
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {renderSectionError('post')}

                <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-t border-white/8 pt-5">
                  <div>
                    <h2 className="text-xl font-semibold text-white">Proof</h2>
                    <p className="mt-1 text-xs text-zinc-400">
                      {hasGeneratedProof
                        ? 'Attached media is locked in.'
                        : 'Add up to 5 images or videos and drag them into the order people should see.'}
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
                        onClick={switchToTextProof}
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
                            category === 'video' ? (
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
                    ) : (
                      <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`rounded-3xl border border-dashed p-5 transition duration-200 ${
                          isDragging
                            ? 'border-sky-400 bg-sky-400/5'
                            : 'border-white/14 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center gap-4">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                              <UploadCloud className="h-6 w-6" />
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-white">
                                {mediaItems.length > 0 ? `${mediaItems.length} of 5 media added` : 'Upload images or videos'}
                              </div>
                              <p className="mt-1 text-xs text-zinc-400">The first item is the Showcase cover.</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => mediaInputRef.current?.click()}
                            disabled={mediaItems.length >= 5}
                            className="inline-flex items-center justify-center gap-2 rounded-full bg-sky-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-200"
                          >
                            <BadgePlus className="h-4 w-4" />
                            {mediaItems.length > 0 ? 'Add more' : 'Add media'}
                          </button>
                        </div>

                        <input
                          ref={mediaInputRef}
                          type="file"
                          accept="image/*,video/*"
                          multiple
                          className="sr-only"
                          onChange={(event) => {
                            // Array.from copies the FileList, so resetting the
                            // input below does not invalidate the async gate's
                            // File references.
                            void appendMediaFiles(Array.from(event.target.files ?? []));
                            event.currentTarget.value = '';
                          }}
                        />

                        {uploadProgress ? (
                          <div className="mt-5 rounded-2xl border border-sky-400/20 bg-sky-400/5 p-4">
                            <div className="flex items-center justify-between gap-4">
                              <div className="text-xs font-medium text-sky-100">
                                Uploading {uploadProgress.completed} of {uploadProgress.total}
                                {uploadProgress.totalBytes > 0
                                  ? ` · ${formatUploadBytes(uploadProgress.bytesSent)} of ${formatUploadBytes(uploadProgress.totalBytes)}`
                                  : ''}
                              </div>
                              <button
                                type="button"
                                onClick={cancelMediaUpload}
                                className="rounded-full border border-white/15 px-3 py-1 text-xs font-semibold text-zinc-200 transition hover:border-white/30 hover:text-white"
                              >
                                Cancel
                              </button>
                            </div>
                            <div
                              role="progressbar"
                              aria-label="Media upload progress"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={uploadProgress.percent}
                              aria-valuetext={`${uploadProgress.percent}% uploaded`}
                              className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"
                            >
                              <div
                                className="h-full rounded-full bg-sky-300 transition-[width] duration-200 ease-out"
                                style={{ width: `${uploadProgress.percent}%` }}
                              />
                            </div>
                          </div>
                        ) : null}

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {coverPreviewItem?.previewUrl ? (
                            coverPreviewItem.mediaKind === 'video' ? (
                              <video
                                src={coverPreviewItem.previewUrl}
                                controls
                                playsInline
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={coverPreviewItem.previewUrl}
                                alt={title || 'Uploaded preview'}
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            )
                          ) : (
                            <div
                              onClick={handleMiddleClick}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  handleMiddleClick();
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              className={`flex min-h-[320px] cursor-pointer flex-col items-center justify-center rounded-[18px] border border-dashed text-center outline-none transition duration-200 ${
                                isDragging
                                  ? 'border-sky-400 bg-sky-400/10 text-sky-200 scale-[0.99]'
                                  : 'border-white/10 bg-zinc-950/60 text-zinc-400 hover:border-white/20 hover:bg-zinc-950/80 hover:text-zinc-300'
                              }`}
                            >
                              {inferredCategory === 'video' ? (
                                <Film className="h-10 w-10 text-zinc-500" />
                              ) : (
                                <ImageIcon className="h-10 w-10 text-zinc-500" />
                              )}
                              <p className="mt-3 text-sm text-zinc-400 font-medium">
                                Drag & drop files, or click to upload
                              </p>
                              <p className="mt-1.5 text-xs text-zinc-500">Up to 5 images or videos</p>
                            </div>
                          )}
                        </div>

                        {mediaPreviewItems.length > 0 ? (
                          <div className="mt-4 flex gap-3 overflow-x-auto pb-1" aria-label="Post media order">
                            {mediaPreviewItems.map((item, index) => (
                              <div
                                key={item.id}
                                ref={(node) => registerMediaCard(item.id, node)}
                                onPointerDown={(event) => handleMediaPointerDown(event, item.id)}
                                onPointerMove={handleMediaPointerMove}
                                onPointerUp={() => handleMediaPointerUp(item.id, index)}
                                onPointerCancel={resetMediaDrag}
                                // The row sits inside the file dropzone; without this a
                                // reorder also lights up "drag & drop files" behind it.
                                onDragStart={(event) => event.preventDefault()}
                                style={{
                                  // Held cards must not also pan the scroll container.
                                  touchAction: draggedMediaId === item.id ? 'none' : undefined,
                                }}
                                className={`group/media-card relative w-28 shrink-0 cursor-grab touch-pan-x rounded-lg border p-1 transition-[border-color,box-shadow,opacity,scale] duration-150 ease-out select-none active:cursor-grabbing ${
                                  draggedMediaId === item.id
                                    ? 'z-10 scale-[1.04] border-sky-300 bg-zinc-900 opacity-90 shadow-[0_8px_24px_rgba(0,0,0,0.45)]'
                                    : index === 0
                                      ? 'border-sky-300/70 bg-zinc-950'
                                      : 'border-white/10 bg-zinc-950'
                                }`}
                              >
                                <div className="relative aspect-[4/5] overflow-hidden rounded-md bg-black">
                                  {item.mediaKind === 'video' ? (
                                    <video
                                      src={item.previewUrl ?? undefined}
                                      muted
                                      playsInline
                                      className="h-full w-full object-contain"
                                    />
                                  ) : (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={item.previewUrl ?? undefined}
                                      alt={`Media ${index + 1}`}
                                      className="h-full w-full object-contain"
                                    />
                                  )}
                                  <div className="absolute left-1 top-1 flex h-7 w-7 items-center justify-center rounded-md bg-black/75 text-zinc-200">
                                    <GripVertical className="h-4 w-4" />
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeMediaItem(item.id)}
                                    aria-label={`Remove media ${index + 1}`}
                                    className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md bg-black/75 text-zinc-200 hover:text-white"
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                  {/*
                                    Tapping the card body already opens the preview.
                                    This is the same action as a real control, so a
                                    keyboard reaches it without the card itself having
                                    to become a button around other buttons.
                                  */}
                                  <button
                                    type="button"
                                    onClick={() => setPreviewMediaIndex(index)}
                                    aria-label={`Preview ${getComposerMediaLabel(index)}`}
                                    className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-md bg-black/75 text-zinc-200 opacity-0 transition-opacity duration-150 ease-out hover:text-white focus-visible:opacity-100 group-hover/media-card:opacity-100"
                                  >
                                    <Maximize2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                                <div className="mt-1 flex items-center justify-between gap-1 px-1 text-[11px] text-zinc-400">
                                  <span>{index === 0 ? 'Cover' : `${index + 1}`}</span>
                                  <div className="flex">
                                    <button
                                      type="button"
                                      disabled={index === 0}
                                      onClick={() => moveMediaItem(item.id, mediaPreviewItems[index - 1]?.id ?? item.id)}
                                      aria-label={`Move media ${index + 1} left`}
                                      className="flex h-6 w-6 items-center justify-center transition-transform duration-100 ease-out active:scale-90 disabled:opacity-25 disabled:active:scale-100"
                                    >
                                      <ArrowLeft className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      disabled={index === mediaPreviewItems.length - 1}
                                      onClick={() => moveMediaItem(item.id, mediaPreviewItems[index + 1]?.id ?? item.id)}
                                      aria-label={`Move media ${index + 1} right`}
                                      className="flex h-6 w-6 items-center justify-center transition-transform duration-100 ease-out active:scale-90 disabled:opacity-25 disabled:active:scale-100"
                                    >
                                      <ArrowRight className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                            {mediaPreviewItems.length < 5 ? (
                              <button
                                type="button"
                                onClick={() => mediaInputRef.current?.click()}
                                aria-label="Add more media"
                                className="group w-28 shrink-0 rounded-lg border border-dashed border-white/15 bg-zinc-950 p-1 text-left transition-[border-color,background-color] duration-150 ease-out hover:border-sky-300/70 hover:bg-zinc-900"
                              >
                                <div className="flex aspect-[4/5] flex-col items-center justify-center gap-2 rounded-md bg-black">
                                  <span className="flex h-10 w-10 items-center justify-center rounded-full border border-sky-400/50 bg-sky-400/10 transition-colors duration-150 ease-out group-hover:bg-sky-400/20">
                                    <Plus className="h-5 w-5 text-sky-300" strokeWidth={2.8} />
                                  </span>
                                  <span className="text-[11px] font-semibold text-white">Add media</span>
                                </div>
                                <div className="mt-1 flex h-6 items-center px-1 text-[11px] text-zinc-400">
                                  {`${5 - mediaPreviewItems.length} ${5 - mediaPreviewItems.length === 1 ? 'slot' : 'slots'} left`}
                                </div>
                              </button>
                            ) : null}
                          </div>
                        ) : null}
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
                        <p className="mt-1 text-xs text-zinc-400">
                          Write your tip or guide in the story section below.
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
                    <p className="mt-1 text-xs text-zinc-400">
                      The public content visible in Showcase.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDetailsOpen((current) => !current)}
                    className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    {isDetailsOpen ? 'Hide description' : 'Add Showcase description'}
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
                        ? 'Write the post content...'
                        : 'Write an optional caption...'
                    }
                    rows={proofMode === 'text' ? 8 : 6}
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {isDetailsOpen ? (
                  <label className="mt-5 block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Showcase description</div>
                    <textarea
                      value={description}
                      onChange={(event) => {
                        setDescription(event.target.value);
                        resetFeedback();
                      }}
                      placeholder="Optional: give the post a short one-line setup for Showcase and previews."
                      rows={3}
                      className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                    />
                  </label>
                ) : null}
              </div>

              <div
                id="recipe"
                ref={resourceSectionRef}
                tabIndex={-1}
                data-composer-section="resources"
                className="rounded-3xl border border-emerald-500/15 bg-emerald-500/5 p-5 outline-none"
              >
                <span id="resources" aria-hidden className="sr-only" />
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Recipe</h2>
                    <p className="mt-1 text-xs text-zinc-400">
                      Add optional reusable inputs (prompts, files, notes, or remix access) to this post. Paid inputs stay hidden until purchase.
                    </p>
                  </div>
                  <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-zinc-300">
                    {resourceAccessMode === 'none' ? 'No recipe' : resourceAccessMode === 'free' ? 'Free recipe' : 'Paid recipe'}
                  </div>
                </div>

                {isGeneratedPaywallIntent ? (
                  <div className="mt-5 rounded-[24px] border border-emerald-300/18 bg-black/30 p-4 text-sm leading-6 text-zinc-200">
                    {isLoadingGeneration
                      ? 'Preparing the saved prompt and generation setup for this paid recipe.'
                      : hasGenerationPaywallPrefill
                        ? 'Saved prompt, reusable setup notes, and remix access are ready where this creation supports them. Set the price first, then publish or edit anything below.'
                        : 'This creation does not have enough saved inputs to auto-fill a paid recipe yet. The media is still attached, and you can add the prompt, notes, or remix access manually below.'}
                  </div>
                ) : isCreationPaywallManagementIntent ? (
                  <div className="mt-5 rounded-[24px] border border-emerald-300/18 bg-black/30 p-4 text-sm leading-6 text-zinc-200">
                    You came from My Studio to manage this post&apos;s recipe. The access mode is ready here, and the price field is focused so you can adjust the paid layer quickly.
                  </div>
                ) : null}

                {resourceAccessMode !== 'none' && displayVisibility !== 'public' ? (
                  <div className="mt-4 rounded-[24px] border border-white/8 bg-black/25 px-4 py-3 text-sm text-zinc-200">
                    This recipe will save as a draft until the post is public.
                  </div>
                ) : null}

                {renderSectionError('resources')}

                <label className="mt-4 flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={resourceAccessMode !== 'none'}
                    disabled={isResourceEditingLocked}
                    onChange={(e) => {
                      setResourceAccessMode(e.target.checked ? 'free' : 'none');
                      resetFeedback();
                    }}
                    className="h-4 w-4 rounded border-white/10 bg-white/[0.03] text-emerald-400 focus:ring-0 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className="text-sm font-semibold text-white">Add a reusable recipe</span>
                </label>

                {isResourceEditingLocked ? (
                  <div className="mt-5 space-y-5">
                    <div className="rounded-[24px] border border-white/8 bg-black/25 p-4">
                      <div className="text-sm font-semibold text-white">Purchased resources are protected</div>
                      <p className="mt-1.5 text-xs leading-5 text-zinc-400">
                        People have already unlocked this package, so its access mode, price, and contents
                        cannot be changed. Visibility changes still apply to the post.
                      </p>
                      <div className="mt-3 text-xs font-medium text-zinc-300">
                        {resourceAccessMode === 'paid'
                          ? `${resourcePriceUsdCents} token paid package`
                          : 'Resource package'}
                        {' · '}
                        {resourceCards.length} {resourceCards.length === 1 ? 'resource' : 'resources'}
                      </div>
                    </div>
                    <ResourceCardsSection
                      cards={resourceCards}
                      mediaCount={mediaPreviewItems.length}
                      disabled
                      allowRemix={resourceAllowRemix}
                      summary={resourceSummary}
                      previewText={resourcePreviewText}
                      suggestedPreview={suggestedResourcePreview}
                      summaryError={null}
                      previewError={null}
                      onAddCard={openResourceTypePicker}
                      onEditCard={editResourceCard}
                      onRemoveCard={removeResourceCard}
                      onAllowRemixChange={setResourceAllowRemix}
                      onSummaryChange={setResourceSummary}
                      onPreviewTextChange={setResourcePreviewText}
                    />
                  </div>
                ) : resourceAccessMode !== 'none' ? (
                  <div className="mt-5 space-y-5">
                    <div className="rounded-[24px] border border-white/8 bg-black/25 p-4 space-y-4">
                      <div className="flex flex-wrap items-center gap-4 sm:justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Access Mode:</span>
                          <div className="inline-flex rounded-full border border-white/10 bg-black/30 p-1">
                            {([
                              { value: 'free', label: 'Free' },
                              { value: 'paid', label: 'Paid' },
                            ] as const).map((mode) => {
                              const active = (resourceAccessMode === 'paid' ? 'paid' : 'free') === mode.value;
                              return (
                                <button
                                  key={mode.value}
                                  type="button"
                                  onClick={() => {
                                    setResourceAccessMode(mode.value);
                                    trackProductEvent('recipe_access_mode_selected', {
                                      access_mode: mode.value,
                                      entry_surface: entrySurface ?? 'direct',
                                    });
                                    resetFeedback();
                                  }}
                                  className={`rounded-full px-4 py-1 text-xs font-semibold transition ${
                                    active
                                      ? 'bg-emerald-300 text-emerald-950'
                                      : 'text-zinc-300 hover:text-white'
                                  }`}
                                >
                                  {mode.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {resourceAccessMode === 'paid' ? (
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Price:</span>
                            <div className="relative inline-flex items-center">
                              <input
                                ref={priceInputRef}
                                type="number"
                                inputMode="numeric"
                                min={POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS}
                                step={POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}
                                aria-label="Price in tokens"
                                placeholder={String(DEFAULT_PRICE_TOKENS)}
                                value={resourcePriceTokens}
                                onChange={(event) => {
                                  setResourcePriceTokens(event.target.value);
                                  resetFeedback();
                                }}
                                className="w-24 rounded-full border border-white/10 bg-white/[0.03] pl-3 pr-14 py-1 text-center text-xs font-semibold text-white outline-none focus:border-emerald-300/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                              />
                              <span className="pointer-events-none absolute right-3 text-xs text-zinc-500">tokens</span>
                            </div>
                            <span className="text-xs text-emerald-200">
                              You earn ~{creatorEarningsTokens} tokens
                            </span>
                          </div>
                        ) : null}
                      </div>

                      <div className="rounded-2xl border border-white/8 bg-white/[0.025] px-4 py-3 text-xs leading-5 text-zinc-400">
                        {resourceAccessMode === 'paid' ? (
                          <>
                            Buyers see the full price before payment, and you keep 85% of it. Before purchase,
                            your public summary, package preview, and the resource titles below are visible.
                            {Number.isFinite(parsedResourcePriceTokens)
                              && parsedResourcePriceTokens > 0
                              && parsedResourcePriceTokens < POST_RESOURCE_WEB_CASH_MIN_TOKENS ? (
                                <>
                                  {' '}Under {POST_RESOURCE_WEB_CASH_MIN_TOKENS} tokens, buyers unlock with
                                  credits rather than a card checkout.
                                </>
                              ) : null}
                          </>
                        ) : (
                          <>People can add a free recipe to their library with one click.</>
                        )}
                      </div>
                    </div>

                    <ResourceCardsSection
                      cards={resourceCards}
                      mediaCount={mediaPreviewItems.length}
                      disabled={isResourceEditingLocked}
                      allowRemix={resourceAllowRemix}
                      summary={resourceSummary}
                      previewText={resourcePreviewText}
                      suggestedPreview={suggestedResourcePreview}
                      summaryError={resourceSummaryError}
                      previewError={resourcePreviewError}
                      onAddCard={openResourceTypePicker}
                      onEditCard={editResourceCard}
                      onRemoveCard={removeResourceCard}
                      onAllowRemixChange={(nextAllowRemix) => {
                        setResourceAllowRemix(nextAllowRemix);
                        resetFeedback();
                      }}
                      onSummaryChange={(nextSummary) => {
                        setResourceSummary(nextSummary);
                        resetFeedback();
                      }}
                      onPreviewTextChange={(nextPreviewText) => {
                        setResourcePreviewText(nextPreviewText);
                        resetFeedback();
                      }}
                    />
                  </div>
                ) : null}
              </div>

              {createdPost ? (
                <div className="rounded-[28px] border border-emerald-500/20 bg-emerald-500/10 p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="text-sm font-semibold text-white">
                      {isEditMode
                        ? 'Changes saved'
                        : createdPost.resourceBundleStatus === 'draft'
                          ? 'Draft saved with a recipe'
                          : createdPostHasResources
                            ? 'Post published with a recipe'
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
                        ? 'The post and recipe are saved for you. Make the post public when you are ready to list the recipe.'
                        : createdPostHasResources
                          ? 'The post is public and its reusable recipe is ready on the same page.'
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
                        Open recipe section
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
                    <p className="mt-1 text-xs text-zinc-400">
                      Choose who can see this post.
                    </p>
                  </div>
                  <div className="shrink-0 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs font-semibold text-zinc-300">
                    {resourceAccessMode === 'none'
                      ? getVisibilityStatusLabel(displayVisibility)
                      : resourceAccessMode === 'paid'
                        ? `${getVisibilityStatusLabel(displayVisibility)} · paid recipe`
                        : `${getVisibilityStatusLabel(displayVisibility)} · free recipe`}
                  </div>
                </div>

                {renderSectionError('publish')}

                {isEditingUnlisted ? (
                  <div className="mt-5 space-y-4">
                    <div className="rounded-[24px] border border-amber-400/20 bg-amber-500/10 px-5 py-4 text-sm leading-6 text-amber-50">
                      This post is currently <span className="font-semibold">Unlisted</span> — shareable by link only.
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('unlisted')}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Save unlisted changes
                      </button>
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('public')}
                        className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Make public
                      </button>
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('private')}
                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Make private
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('private')}
                        className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-5 text-left transition hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <div className="text-sm font-semibold text-zinc-200">Save private</div>
                        <p className="mt-1.5 text-xs leading-5 text-zinc-500">Saved privately in Studio.</p>
                      </button>
                      <button
                        type="submit"
                        disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                        onClick={() => submitWithVisibility('public')}
                        className="ui-focus-ring rounded-2xl bg-[var(--ui-primary)] px-5 py-5 text-left transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <div className="text-sm font-extrabold text-[var(--ui-primary-on)]">Publish public</div>
                        <p className="mt-1.5 text-xs leading-5 text-[#5c2c20]">Visible in Showcase.</p>
                      </button>
                    </div>
                  </div>
                )}

              </div>
            </form>
          </section>

          <aside aria-label="Publish checklist" className="lg:sticky lg:top-24">
            <div className="rounded-3xl border border-white/8 bg-zinc-900/60 p-5 shadow-[0_20px_50px_rgba(0,0,0,0.28)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Publish checklist</div>
              <div className="mt-4 space-y-3">
                {completionChecklist.map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                      item.complete
                        ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-100'
                        : 'border-white/10 bg-white/[0.04] text-zinc-500'
                    }`}>
                      {item.complete ? <Check className="h-4 w-4" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{item.label}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>

      <ComposerMediaLightbox
        items={mediaPreviewItems}
        activeIndex={previewMediaIndex}
        onClose={() => setPreviewMediaIndex(null)}
        onNavigate={setPreviewMediaIndex}
      />

      <ResourceCardEditorDialog
        card={editingResourceCard}
        isChoosingType={isChoosingResourceType}
        mediaOptions={resourceScopeMediaOptions}
        // A generation-backed publish validates scopes against a single
        // synthetic media key, so per-output scoping is only offered when the
        // composer owns the media itself.
        canScopeToMedia={!generationId}
        onChooseType={chooseResourceCardType}
        onChange={updateEditingResourceCard}
        onSave={saveResourceCard}
        onClose={closeResourceEditor}
        onUploadFile={uploadResourceCardFile}
      />
    </div>
  );
}
