'use client';

import { readVideoDurationSeconds } from '@/lib/video-metadata-probe';

import InlineMediaVideo from '@/components/InlineMediaVideo';

import Link from 'next/link';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  BadgePlus,
  BookText,
  Check,
  ChevronDown,
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

import { useAuth } from '@/components/AuthProvider';
import PublicIdentityFields from '@/components/PublicIdentityFields';
import type { ConfirmationRequest } from '@/components/feedback-state';
import { useConfirmation } from '@/components/useConfirmation';
import type { GenerationPaywallPrefill } from '@/lib/generation-paywall';
import { isGenerationPaywallPrefill } from '@/lib/creation-publish-details';
import {
  assessMarketplaceListingQuality,
  getPublicPostQualityError,
  isCreatorProfileReadinessError,
  PUBLIC_POST_PLACEHOLDER_TITLE_ERROR,
} from '@/lib/marketplace-trust';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';
import {
  followCreationTitleSuggestion,
  getCreationPostTitleSuggestion,
  getCreationTitleSuggestionHint,
  recipeKeepsPromptPrivate,
} from '@/lib/creation-post-title';
import {
  claimPublicIdentity,
  getInitialPublicIdentity,
  isPublicIdentityReady,
  loadOwnProfile,
  validatePublicIdentity,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
  type PublicIdentityProfile,
} from '@/lib/public-identity';
import { createClientPostMediaKey, defaultPostMediaKey } from '@/lib/post-media-key';
import {
  POST_VIDEO_DURATION_LIMIT_MESSAGE,
  POST_VIDEO_MAX_DURATION_SECONDS,
  POST_VIDEO_MAX_UPLOAD_BYTES,
  POST_VIDEO_UPLOAD_BYTES_MESSAGE,
} from '@/lib/post-video-limits';
import { buildShowcaseDetailPath, getCurrentInternalPath, getSafeInternalReturnPath } from '@/lib/share';
import { sharePublicGeneration } from '@/lib/share-client';
import { forgetCreationsWorkspaceCache } from '@/lib/creations-workspace-cache';
import { pushToast } from '@/components/feedback-state';
import { trackProductEvent } from '@/lib/product-analytics';
import { useLeaveGuard } from '@/lib/use-leave-guard';
import {
  normalizePostResourceItems,
  normalizePostResourceBundleAccessMode,
  POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS,
  POST_RESOURCE_PRICE_INCREMENT_USD_CENTS,
  type PostResourceAttachment,
  type PostResourceBundleInput,
  type PostResourceBundleAccessMode,
} from '@/lib/post-resource-bundles';
import {
  POST_RESOURCE_WEB_CASH_MIN_TOKENS,
} from '@/lib/post-resource-commerce';
import { formatRecipeMoneyLine } from '@/lib/recipe-money-line';
import { slugifySourceTool, type SourceToolOption } from '@/lib/source-tools';
import { buildGenerationPostSourceTools } from '@/lib/generation-post-source-tools';
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
  createPostComposerResourceCard,
  getSuggestedRecipePreview,
  hydratePostComposerAllowRemix,
  hydratePostComposerResourceCards,
  resourceCardHasContent,
  type PostComposerResourceCardDraft,
  type PostComposerResourceCardType,
} from '@/lib/post-composer-resource-cards';
import ComposerMediaLightbox, { getComposerMediaLabel } from './ComposerMediaLightbox';
import ResourceCardEditorDialog from './ResourceCardEditorDialog';
import RecipeAccessCards from './RecipeAccessCards';
import ResourceCardsSection, { RECIPE_PREVIEW_MAX_LENGTH } from './ResourceCardsSection';
import CreatableCombobox, { type CreatableComboboxOption } from './CreatableCombobox';
import type { EditablePostDraft } from './post-editor-types';

const LEAVE_WITH_UNSAVED_CHANGES: ConfirmationRequest = {
  title: 'Leave this post?',
  message: 'Your changes haven’t been saved and will be lost.',
  confirmLabel: 'Leave without saving',
  cancelLabel: 'Keep editing',
  tone: 'danger',
};

/**
 * Asked when an edit's save would take the post's recipe off (H2,
 * 2026-10-27): the server deletes it with its files, or retires it when
 * people have it. The app's composer asks the same.
 */
function getRecipeRemovalQuestion(itemCount: number, buyerCount: number, reopensPost: boolean): ConfirmationRequest {
  const items = itemCount > 0
    ? `Its ${itemCount} ${itemCount === 1 ? 'item' : 'items'} and files will be deleted.`
    : 'It will be deleted.';
  const buyers = buyerCount <= 0
    ? ''
    : buyerCount === 1
      ? ' The 1 person who has it keeps their copy; it comes off sale.'
      : ` The ${buyerCount} people who have it keep their copy; it comes off sale.`;
  // A creation post without a recipe shows its prompt and lets anyone remix
  // (S1): taking the recipe off puts the post back that way, said here rather
  // than found out (review of #567, 2026-10-28).
  const reopened = reopensPost
    ? ' The post’s prompt and Remix will be open to everyone again, as on any post without a recipe.'
    : '';
  return {
    title: 'Remove this recipe?',
    message: `${items}${buyers}${reopened}`,
    confirmLabel: 'Remove recipe',
    cancelLabel: 'Keep recipe',
    tone: 'danger',
  };
}

const RECIPE_EMPTY_ERROR = 'Add at least one item to the recipe.';
const RECIPE_PREVIEW_REQUIRED_ERROR = 'Add a recipe preview.';
// The listing rule's preview half (18 characters, no stand-in words), in the
// app's words; `assessMarketplaceListingQuality` holds the rule.
const RECIPE_PREVIEW_QUALITY_ERROR = 'Write a recipe preview of at least 18 characters that says what people get.';
const RECIPE_PRICE_ERROR = `Paid recipes start at ${POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS} credits, in steps of ${POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}.`;

/** The item "Include exact prompt" makes, titled as the app titles it (A-F16). */
const CREATION_PROMPT_ITEM_TITLE = 'Exact generation prompt';

/** A post is public or private (decision 12, 2026-10-17). */
type PostVisibility = 'public' | 'private';
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

/**
 * What leaving the composer would lose, in comparable form: media by identity
 * and order, Made With rows by what they name (an empty row holds nothing).
 */
interface ComposerSnapshot {
  title: string;
  body: string;
  visibility: PostVisibility;
  isNsfw: boolean;
  mediaIds: string[];
  madeWith: Array<Omit<MadeWithRow, 'id'>>;
  resourceAccessMode: PostResourceBundleAccessMode;
  resourceCards: PostComposerResourceCardDraft[];
  /**
   * The Recipe preview the creator wrote, or null while it is the suggestion,
   * which follows from the cards above.
   */
  resourcePreviewWritten: string | null;
  resourcePriceTokens: string;
  includeGenerationReferences: boolean;
}

// Field by field, cheapest first, so a keystroke in the title never serializes
// the recipe cards (a hydrated card can carry a whole workflow graph).
function isSameComposerSnapshot(a: ComposerSnapshot, b: ComposerSnapshot): boolean {
  return a.title === b.title
    && a.body === b.body
    && a.visibility === b.visibility
    && a.isNsfw === b.isNsfw
    && a.resourceAccessMode === b.resourceAccessMode
    && a.resourcePreviewWritten === b.resourcePreviewWritten
    && a.resourcePriceTokens === b.resourcePriceTokens
    && a.includeGenerationReferences === b.includeGenerationReferences
    && a.mediaIds.join('\n') === b.mediaIds.join('\n')
    && JSON.stringify(a.madeWith) === JSON.stringify(b.madeWith)
    // By content, not identity: saving a card unchanged still copies it.
    && (a.resourceCards === b.resourceCards || JSON.stringify(a.resourceCards) === JSON.stringify(b.resourceCards));
}

// Made With rows as the snapshot holds them: what each names, in the one key
// order the comparison above serializes.
function snapshotMadeWith(rows: MadeWithRow[]): ComposerSnapshot['madeWith'] {
  return rows
    .filter((row) => row.toolLabel.trim() || row.modelLabel.trim())
    .map(({ toolLabel, toolSlug, modelLabel, modelSlug, createTool, createModel }) => ({
      toolLabel,
      toolSlug,
      modelLabel,
      modelSlug,
      createTool,
      createModel,
    }));
}

/**
 * A new post's Made with for a creation: the row publishing stores for it
 * (`buildGenerationPostSourceTools`, no stored tool being the app's), so the
 * creation's model by the name its post prints, or none where that name is
 * missing, as a template result's `template-workflow` is.
 */
function creationMadeWithRow(shownModel: string): MadeWithRow {
  const [stored] = buildGenerationPostSourceTools({ source_tool: null, source_tool_slug: null }, shownModel);
  return {
    id: 'mw-0',
    toolLabel: stored.toolLabel,
    toolSlug: stored.toolSlug ?? '',
    modelLabel: stored.modelLabel ?? '',
    modelSlug: stored.modelSlug ?? '',
    createTool: false,
    createModel: false,
  };
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

/** A media row of a saved post, as an edit's answer or the owner read lists it. */
interface SavedMediaRow {
  id: string;
  mediaKey: string;
}

/**
 * The rows listed in `value`, or null when it lists none. A row read back
 * without a key carries the positional one the server derives for it.
 */
function readSavedMediaRows(value: unknown): SavedMediaRow[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.flatMap((row: unknown, index) => {
    const { id, mediaKey } = (row ?? {}) as { id?: unknown; mediaKey?: unknown };
    return typeof id === 'string'
      ? [{ id, mediaKey: typeof mediaKey === 'string' && mediaKey ? mediaKey : defaultPostMediaKey(index) }]
      : [];
  });
}

/**
 * Media the post now holds is named by its row id from here on, and its staged
 * upload, which the save used up, is never sent again.
 */
function withSavedMediaRows(items: ComposerMediaItem[], rows: SavedMediaRow[]): ComposerMediaItem[] {
  const idsByKey = new Map(rows.map((row) => [row.mediaKey, row.id]));
  return items.map((item) => {
    const savedId = idsByKey.get(item.mediaKey);
    return savedId ? { ...item, existingId: savedId, storagePath: null } : item;
  });
}

/**
 * Aggregate byte progress for the one upload bar. Files upload as soon as they
 * are added, and publish uploads only what did not make it, so this bar is the
 * only place the wait shows -- and Cancel on it is the only way to stop it.
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

/** The section a server refusal is written in, by the field it names. */
function getRefusalSection(field: string | undefined): ComposerError['section'] {
  if (field === 'sourceTools') {
    return 'post';
  }
  // The recipe's items, preview and summary (a safety rule or a length cap).
  if (field === 'resourceCards' || field === 'resourcePreview' || field === 'resourceSummary') {
    return 'resources';
  }
  return 'publish';
}

function getSubmissionError(
  data: { error?: string; field?: string; actionHref?: string; actionLabel?: string },
  fallback: string
) {
  const message = data.error || fallback;
  const needsProfileRepair = data.field === 'profile' || isCreatorProfileReadinessError(message);
  return new ComposerSubmissionError(
    message,
    getRefusalSection(data.field),
    needsProfileRepair
      ? {
          href: buildProfileRepairHref(),
          label: 'Complete profile in a new tab',
        }
      : undefined
  );
}

type SaveResponseBody = Record<string, unknown> & {
  error?: string;
  field?: string;
  actionHref?: string;
  actionLabel?: string;
};

/**
 * Reads a create or edit response, and says whether that save may have consumed
 * the staged uploads it named. The server moves each staged file into the post
 * before it checks the Made With catalog, so that refusal comes after the move,
 * and a 5xx can too (a gateway error page is not even JSON). Every other refusal
 * is decided before a staged file is touched.
 */
async function readSaveResponse(
  response: Response
): Promise<{ data: SaveResponseBody; stagedMediaConsumed: boolean }> {
  const data = await readResponseBody(response);
  return { data, stagedMediaConsumed: response.status >= 500 || (!response.ok && data.field === 'sourceTools') };
}

/**
 * A refusal's body. A proxy's or gateway's error page is HTML, and reading it
 * as JSON put a parse error where the refusal belongs; the caller's fallback
 * message says it instead. An answer that says it succeeded must be JSON.
 */
async function readResponseBody(response: Response): Promise<SaveResponseBody> {
  if (response.ok) {
    return await response.json() as SaveResponseBody;
  }
  return await response.json().catch(() => ({})) as SaveResponseBody;
}

/** The post's media rows as they are now, for a save whose ids may be out of date. */
async function readBackSavedMediaRows(postId: string, accessToken: string): Promise<SavedMediaRow[]> {
  const response = await fetch(`/api/posts/${postId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => null);
  const data = response?.ok
    ? await response.json().catch(() => null) as { post?: { mediaItems?: unknown } } | null
    : null;
  const rows = readSavedMediaRows(data?.post?.mediaItems);
  if (!rows) {
    throw new ComposerSubmissionError('Could not check this post’s media before saving. Try again.', 'publish');
  }
  return rows;
}

interface GenerationDraft {
  id: string;
  title: string;
  /** A template result's template name, which counts as its own title when it has none. */
  templateTitle: string;
  prompt: string;
  /** `'motion'` for a motion transfer, whose category reads 'video'. */
  creationMode: string | null;
  outputUrl: string | null;
  category: PostMediaCategory;
  model: string;
  paywallPrefill: GenerationPaywallPrefill | null;
  /** A template result shares its media only; its private recipe stays protected. */
  origin: 'template' | 'direct' | null;
  /** Saved inputs with a stored file, which publish can copy into the recipe. */
  referenceCount: number;
  /**
   * Edit mode seeds a draft from the server-rendered post before the
   * generations fetch resolves. The paywall prefill must only conclude
   * "nothing to apply" from a fetched draft — the seed never carries one.
   */
  source: 'seed' | 'fetched';
}

const BODY_MAX_LENGTH = 2000;

// Media reorder gesture, matched to the mobile composer so the interaction reads
// the same on both. w-28 (112px) + gap-3 (12px) is how far one slot is.
const MEDIA_CARD_STEP = 124;
const MEDIA_DRAG_HOLD_MS = 300;
const MEDIA_DRAG_SLOP = 8;

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

/**
 * The card a creation's prompt becomes. The "sell recipe" prefill and the
 * "Include exact prompt" toggle both build it here, so they make the same card,
 * and the app's toggle makes the same item.
 */
function createCreationPromptCard(prompt: string): PostComposerResourceCardDraft {
  return createPostComposerResourceCard('prompt', { title: CREATION_PROMPT_ITEM_TITLE, textContent: prompt });
}

// The toggle reads its state from the package itself, so it shows what a
// prefill or an earlier save already included.
function isCreationPromptCard(card: PostComposerResourceCardDraft, prompt: string): boolean {
  return card.type === 'prompt' && card.textContent.trim() === prompt;
}

/** A promise publish can wait on, settled by whoever ends the upload first. */
function createUploadWait(): { settled: Promise<void>; settle: () => void } {
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { settled, settle };
}

function formatGeneratedCategory(value: string | null | undefined): PostMediaCategory {
  if (value === 'video' || value === 'motion' || value === 'ugc-ad') {
    return 'video';
  }

  return 'image';
}

function getVisibilityStatusLabel(v: PostVisibility): string {
  if (v === 'public') return 'Visible in Explore';
  return 'Saved privately in Studio';
}

/**
 * A post saved as unlisted before 2026-10-17 opens as private: the server
 * stores a requested unlisted post as private on every save anyway.
 */
function getComposerVisibility(stored: EditablePostDraft['visibility'] | undefined): PostVisibility {
  return stored === 'unlisted' ? 'private' : stored ?? 'public';
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
      throw new Error(uploadIntent.error || 'Failed to prepare the file upload.');
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
      throw new Error('The finished upload did not match its signed target.');
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
 * Prices are credit counts, and `price_usd_cents` stores the count directly --
 * at the fixed 100 credits to $1 the two numbers are equal.
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

function hasUsableGenerationPaywallPrefill(prefill: GenerationPaywallPrefill | null | undefined): boolean {
  return Boolean(prefill && prefill.resourceKinds.length > 0);
}

interface NewPostClientProps {
  initialPost?: EditablePostDraft | null;
  /**
   * The profile's handle and name as the page's server render read them, or
   * null when it did not (the composer then reads them itself).
   */
  initialPublicIdentity?: PublicIdentityProfile | null;
}

export default function NewPostClient({ initialPost = null, initialPublicIdentity = null }: NewPostClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, user } = useAuth();
  const [isNsfw, setIsNsfw] = useState(initialPost?.isNsfw === true);
  const generationId = initialPost?.generationId ?? searchParams.get('generationId');
  const isEditMode = Boolean(initialPost);
  const publishIntent = searchParams.get('publishIntent');
  const requestedResourceMode = searchParams.get('resourceMode');
  const requestedFocusTarget = searchParams.get('focus');
  const entrySurface = searchParams.get('from');
  // A template run's "Publish & share", as the app's: the share opens once the
  // creation's post is public, before the page leaves for it.
  const sharesAfterPublish = searchParams.get('shareAfterPublish') === '1';
  const isGeneratedPaywallIntent = publishIntent === 'paid-generation' && Boolean(generationId);
  const isCreationPaywallManagementIntent =
    isEditMode && entrySurface === 'creations' && requestedFocusTarget === 'price';
  // "Add a recipe" (`recipe=add`, A-F17), from Studio, Recipe sales or
  // anywhere else that sends it: the post's recipe section with no mode
  // chosen and nothing focused, not "Manage recipe"'s Paid and price.
  const isRecipeAddIntent = isEditMode && searchParams.get('recipe') === 'add';
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
  const [visibility, setVisibility] = useState<PostVisibility>(() => getComposerVisibility(initialPost?.visibility));
  const [category, setCategory] = useState<PostMediaCategory>(initialCategory);
  // Folded into one row that sums it up, as the app's.
  const [isMadeWithOpen, setIsMadeWithOpen] = useState(false);
  const madeWithPanelId = useId();
  const recipeMoneyLineId = useId();
  const [resourceAccessMode, setResourceAccessMode] = useState<PostResourceBundleAccessMode>(initialResourceAccessMode);
  // Read by the creation load below, which suggests a title for the recipe
  // state at the moment the creation arrives.
  const resourceAccessModeRef = useRef(resourceAccessMode);
  useEffect(() => {
    resourceAccessModeRef.current = resourceAccessMode;
  }, [resourceAccessMode]);
  // A public post needs a claimed handle and a display name. Known from the
  // server render, so a creator without them is asked beside the publish
  // buttons from the start and the post saves them first, instead of being
  // refused once everything is uploaded.
  const [composerProfile, setComposerProfile] = useState<PublicIdentityProfile | null>(initialPublicIdentity);
  // Set when the server refused a public post for the profile although it
  // could not be read here: the fields then show.
  const [profileRefused, setProfileRefused] = useState(false);
  // The fields follow the profile and the sign-in until the creator types.
  const [identityEdits, setIdentityEdits] = useState<PublicIdentityDraft | null>(null);
  const [identityErrors, setIdentityErrors] = useState<PublicIdentityErrors>({});
  const identity = identityEdits ?? getInitialPublicIdentity(composerProfile, user);
  const needsPublicIdentity = profileRefused || (composerProfile !== null && !isPublicIdentityReady(composerProfile));
  // Only when the server render could not say: read it here instead.
  const shouldReadProfile = initialPublicIdentity === null;
  useEffect(() => {
    const accessToken = session?.access_token;
    if (!shouldReadProfile || !accessToken) {
      return;
    }
    const controller = new AbortController();
    void loadOwnProfile(accessToken, controller.signal).then((profile) => {
      if (profile && !controller.signal.aborted) {
        setComposerProfile(profile);
      }
    });
    return () => controller.abort();
  }, [session?.access_token, shouldReadProfile]);
  // One card is one thing a buyer receives. The serialization lives in
  // post-composer-resource-cards.ts, which the mobile composer mirrors.
  const [initialResourceCards] = useState<PostComposerResourceCardDraft[]>(
    () => hydratePostComposerResourceCards(withSynthesizedResourceItems(initialBundle))
  );
  const [resourceCards, setResourceCards] = useState<PostComposerResourceCardDraft[]>(initialResourceCards);
  // Remix is no switch (S1, 2026-10-27): the server gates a creation post's
  // Remix at its recipe's unlock. A new recipe sends false; an edit sends back
  // the value it was loaded with.
  const [resourceAllowRemix] = useState(() => hydratePostComposerAllowRemix(initialBundle));
  // The recipe as last stored, for the question an edit's save asks before it
  // takes the recipe off the post.
  const [storedRecipe, setStoredRecipe] = useState(() => ({
    accessMode: normalizePostResourceBundleAccessMode(initialBundle.accessMode),
    itemCount: initialResourceCards.length,
  }));
  // The one public text (S6). An edit starts from the summary buyers saw
  // first, else the preview; a recipe stored with neither, from the
  // suggestion. `resourcePreviewSuggestion` is the suggestion the text was
  // last measured against, for the follow rule below.
  const [resourcePreviewSuggestion, setResourcePreviewSuggestion] = useState(
    () => getSuggestedRecipePreview(initialResourceCards.filter((card) => resourceCardHasContent(card)))
  );
  const [resourcePreviewText, setResourcePreviewText] = useState(() => (
    initialBundle.summary?.trim() || initialBundle.previewText?.trim() || resourcePreviewSuggestion
  ).slice(0, RECIPE_PREVIEW_MAX_LENGTH));
  const [resourcePriceTokens, setResourcePriceTokens] = useState(() => getInitialPriceTokens(initialBundle));
  const [editingResourceCard, setEditingResourceCard] = useState<PostComposerResourceCardDraft | null>(null);
  const [isChoosingResourceType, setIsChoosingResourceType] = useState(false);
  const [didApplyGenerationPaywallPrefill, setDidApplyGenerationPaywallPrefill] = useState(false);
  const [didFocusPriceInput, setDidFocusPriceInput] = useState(false);
  const [error, setError] = useState<ComposerError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<MediaUploadProgress | null>(null);
  // Opt-in, as in the app: the publish route copies the creation's saved
  // inputs into the recipe as reference files.
  const [includeGenerationReferences, setIncludeGenerationReferences] = useState(false);
  const [createdPost, setCreatedPost] = useState<CreatedPostState | null>(null);
  const [prefilledGeneration, setPrefilledGeneration] = useState<GenerationDraft | null>(() =>
    initialPost?.generationId
      ? {
          id: initialPost.generationId,
          title: initialPost.title,
          templateTitle: '',
          prompt: initialPost.prompt,
          creationMode: null,
          outputUrl: initialPost.mediaUrl,
          category: initialCategory,
          model: 'magicbooklet',
          paywallPrefill: null,
          origin: null,
          referenceCount: 0,
          source: 'seed',
        }
      : null
  );
  const [isLoadingGeneration, setIsLoadingGeneration] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const submitVisibilityRef = useRef<PostVisibility>(getComposerVisibility(initialPost?.visibility));
  const priceInputRef = useRef<HTMLInputElement | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const postSectionRef = useRef<HTMLDivElement | null>(null);
  const storySectionRef = useRef<HTMLDivElement | null>(null);
  const resourceSectionRef = useRef<HTMLDivElement | null>(null);
  const publishSectionRef = useRef<HTMLDivElement | null>(null);
  const savedPanelRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // One object URL per picked file, kept until the file leaves the list. The
  // URLs were rebuilt for every file on every change (a reorder, an upload
  // finishing), so each thumbnail re-decoded and the cover video restarted.
  const objectUrlsRef = useRef(new Map<string, string>());
  const mediaPreviewItems = useMemo(() => {
    const urls = objectUrlsRef.current;
    const liveIds = new Set(mediaItems.map((item) => item.id));
    for (const [id, url] of urls) {
      if (!liveIds.has(id)) {
        URL.revokeObjectURL(url);
        urls.delete(id);
      }
    }
    return mediaItems.map((item) => {
      if (!item.file) return { ...item, previewUrl: item.existingUrl };
      let url = urls.get(item.id);
      if (!url) {
        url = URL.createObjectURL(item.file);
        urls.set(item.id, url);
      }
      return { ...item, previewUrl: url };
    });
  }, [mediaItems]);
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
  const [generationLoadAttempt, setGenerationLoadAttempt] = useState(0);
  const [linkedPostRedirectId, setLinkedPostRedirectId] = useState<string | null>(null);
  // "From this creation", as the app offers it: only once the creation itself
  // has loaded, and never for a template result, whose recipe stays protected.
  const canOfferCreationResources = prefilledGeneration?.source === 'fetched'
    && prefilledGeneration.origin !== 'template';
  const creationPrompt = canOfferCreationResources ? (prefilledGeneration?.prompt.trim() ?? '') : '';
  // Only the publish route copies a creation's inputs; an edit has no such step.
  const canIncludeGenerationReferences = canOfferCreationResources
    && !isEditMode
    && (prefilledGeneration?.referenceCount ?? 0) > 0;
  // Ticked, the creation's saved inputs are an item of the recipe (A-F9).
  const includesCreationReferences = includeGenerationReferences && canIncludeGenerationReferences;
  const readyResourceCards = useMemo(
    () => resourceCards.filter((card) => resourceCardHasContent(card)),
    [resourceCards]
  );
  const suggestedResourcePreview = useMemo(
    () => getSuggestedRecipePreview(readyResourceCards, { creationReferences: includesCreationReferences }),
    [includesCreationReferences, readyResourceCards]
  );
  // S6: the preview follows the suggestion while it still says what was
  // suggested, or nothing, and keeps what the creator wrote. Adjusted while
  // rendering, as React adjusts state that tracks a value, so every way the
  // items change (a save, a removal, a prefill, a tick) is covered once. The
  // app's composer applies the same rule.
  if (suggestedResourcePreview !== resourcePreviewSuggestion) {
    setResourcePreviewSuggestion(suggestedResourcePreview);
    if (!resourcePreviewText.trim() || resourcePreviewText === resourcePreviewSuggestion) {
      setResourcePreviewText(suggestedResourcePreview.slice(0, RECIPE_PREVIEW_MAX_LENGTH));
    }
  }
  // Unsaved work is any field that differs from the post as loaded, or as last
  // saved. The old check read only the title and new files, so a typed body, a
  // recipe, or any edit to an existing post was lost without a prompt. (The app
  // autosaves a draft instead.)
  const composerSnapshot = useMemo<ComposerSnapshot>(() => ({
    title,
    body,
    visibility,
    isNsfw,
    mediaIds: mediaItems.map((item) => item.id),
    madeWith: snapshotMadeWith(madeWithRows),
    resourceAccessMode,
    resourceCards,
    // A preview that is the suggestion follows from the cards: a prefill that
    // writes one is where the post starts, not an edit to lose.
    resourcePreviewWritten: resourcePreviewText === suggestedResourcePreview ? null : resourcePreviewText,
    resourcePriceTokens,
    includeGenerationReferences,
  }), [
    body,
    includeGenerationReferences,
    isNsfw,
    madeWithRows,
    mediaItems,
    resourceAccessMode,
    resourceCards,
    resourcePreviewText,
    resourcePriceTokens,
    suggestedResourcePreview,
    title,
    visibility,
  ]);
  // Moves forward on a save, and absorbs what a linked creation prefills: that
  // is where the post starts, not an edit the user would lose.
  const [savedSnapshot, setSavedSnapshot] = useState(composerSnapshot);
  const hasUnsavedWork = useMemo(
    () => !isSameComposerSnapshot(composerSnapshot, savedSnapshot),
    [composerSnapshot, savedSnapshot]
  );
  // One guard for every way out while there is unsaved work: Back and the
  // phone's back swipe, every link on the page (the shell's, and this page's
  // own Back link), the shell's search, and a reload or a closed tab. Never
  // rename the key: open tabs keep their history entries across a deploy.
  const { leave: leaveComposer } = useLeaveGuard({
    isDirty: hasUnsavedWork,
    question: LEAVE_WITH_UNSAVED_CHANGES,
    historyKey: 'postComposerLeaveGuard',
  });
  // Whether the page is still the composer. Back and its own Back link stay
  // live while a post is sent, and a publish answered after the person left
  // must neither share nor take them anywhere.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const askToConfirm = useConfirmation();
  const trimmedBody = body.trim();
  const bodyCount = body.length;
  const titleCount = title.trim().length;
  // A paid recipe keeps the creation's prompt out of the title; a free one does not (owner, 2026-10-29).
  const promptPrivate = recipeKeepsPromptPrivate(resourceAccessMode);
  const creationTitleSource = prefilledGeneration
    ? {
        prompt: prefilledGeneration.prompt,
        model: prefilledGeneration.model,
        category: prefilledGeneration.category,
        creationMode: prefilledGeneration.creationMode,
      }
    : null;
  // "Suggested" speaks only of a new post's starting title, never of an edit's saved one.
  const titleSuggestionHint = !isEditMode && creationTitleSource
    ? getCreationTitleSuggestionHint(
      title,
      getCreationPostTitleSuggestion(
        prefilledGeneration?.title || prefilledGeneration?.templateTitle,
        creationTitleSource,
        promptPrivate,
      ),
      promptPrivate,
    )
    : null;
  // Every change of the recipe's mode goes through here, so a title cut from
  // the prompt follows it, in an edit too: the prompt may give the title only
  // while no paid recipe keeps the prompt private.
  const changeResourceAccessMode = (nextMode: PostResourceBundleAccessMode) => {
    if (creationTitleSource) {
      setTitle((current) => followCreationTitleSuggestion({
        title: current,
        source: creationTitleSource,
        wasPrivate: promptPrivate,
        isPrivate: recipeKeepsPromptPrivate(nextMode),
      }));
    }
    setResourceAccessMode(nextMode);
  };
  const hasMediaProof = proofMode === 'media' && (mediaItems.length > 0 || hasGeneratedProof);
  const postFormat: PostFormat = hasMediaProof ? (trimmedBody ? 'mixed' : 'media') : 'text';
  // An edit's buttons speak from the visibility the post has, which only a save
  // changes; a new post's state follows the button pressed last.
  const savedVisibility = savedSnapshot.visibility;
  const displayVisibility = isEditMode ? savedVisibility : visibility;
  const generationPaywallPrefill = prefilledGeneration?.paywallPrefill ?? null;
  const hasGenerationPaywallPrefill = hasUsableGenerationPaywallPrefill(generationPaywallPrefill);
  const shouldFocusPriceInput =
    requestedFocusTarget === 'price' && (isGeneratedPaywallIntent || isCreationPaywallManagementIntent);
  // A recipe people have stays editable (D1, 2026-10-27): each save is a new
  // version, and they keep the one they got. The composer says how many.
  const recipeBuyerCount = Math.max(0, initialPost?.resourceBundleBuyerCount ?? 0);
  // A creation post's recipe includes its Remix (S1); a template result has
  // no recipe at all.
  const recipeIncludesRemix = Boolean(generationId) && prefilledGeneration?.origin !== 'template';
  const hasResourceContent = readyResourceCards.length > 0;
  const isCreationPromptIncluded = Boolean(creationPrompt)
    && resourceCards.some((card) => isCreationPromptCard(card, creationPrompt));
  const parsedResourcePriceTokens = Number.parseInt(resourcePriceTokens.trim() || '0', 10);
  const resourcePriceUsdCents = resourceAccessMode === 'paid' && Number.isFinite(parsedResourcePriceTokens)
    ? Math.round(parsedResourcePriceTokens)
    : 0;
  // Clamped rather than guarded at the render site, so an empty or nonsense
  // price reads as nothing yet instead of hiding the line entirely.
  const recipeMoneyLine = formatRecipeMoneyLine(
    Number.isFinite(parsedResourcePriceTokens) ? parsedResourcePriceTokens : 0
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
  // The preview goes as the preview, and the serializer copies it into the
  // summary (S6): one text, so listings and search read the same words.
  const resourceBundleDraft = useMemo<PostResourceBundleInput | null>(
    () => buildResourceCardBundleInput({
      accessMode: resourceAccessMode,
      cards: resourceCards,
      allowRemix: resourceAllowRemix,
      summary: '',
      previewText: resourcePreviewText,
      priceTokens: resourcePriceUsdCents,
      includesServerItems: includesCreationReferences,
    }),
    [
      includesCreationReferences,
      resourceAccessMode,
      resourceAllowRemix,
      resourceCards,
      resourcePreviewText,
      resourcePriceUsdCents,
    ]
  );
  // The preview's own two rules speak under it as well as at the section's top.
  const resourcePreviewError = error?.section === 'resources'
    && (error.message === RECIPE_PREVIEW_REQUIRED_ERROR || error.message === RECIPE_PREVIEW_QUALITY_ERROR)
      ? error.message
      : null;
  const publicPostTitle = title.trim() || (trimmedBody ? trimmedBody.split(/[.!?\n]/)[0]?.trim() ?? '' : '');
  const hasTitle = title.trim().length > 0;
  const completionChecklist = [
    {
      label: 'Title added',
      complete: hasTitle,
    },
    proofMode === 'text'
      ? {
          // The server's own bar for a public post without media.
          label: 'Post text added',
          complete: !getPublicPostQualityError({ body: trimmedBody, hasMedia: false }),
        }
      : {
          label: 'Media added',
          complete: hasMediaProof,
        },
    ...(proofMode === 'text' ? [] : [{ label: 'Story optional', complete: true }]),
    {
      label: 'Recipe optional',
      complete: resourceAccessMode === 'none' || hasResourceContent || includesCreationReferences,
    },
    ...(needsPublicIdentity
      ? [{ label: 'Name and handle', complete: Object.keys(validatePublicIdentity(identity, composerProfile?.username)).length === 0 }]
      : []),
  ];
  const stepBadgeLabel = hasGeneratedProof ? 'Generated media attached' : proofMode === 'text' ? 'Text post' : 'Media post';
  const bodyFieldLabel = proofMode === 'text' ? 'Post text' : 'Story';
  const primaryMadeWith = madeWithRows.find((row) => row.toolLabel.trim());
  const madeWithSummary = primaryMadeWith
    ? [primaryMadeWith.toolLabel.trim(), primaryMadeWith.modelLabel.trim()].filter(Boolean).join(' · ')
    : 'Add tool and model';

  useEffect(() => () => {
    const urls = objectUrlsRef.current;
    for (const url of urls.values()) {
      URL.revokeObjectURL(url);
    }
    urls.clear();
  }, []);

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

    // The saved generation seeds the recipe as cards rather than loose fields,
    // so a prefilled recipe is editable in exactly the same way as a hand-built
    // one. Built once, outside the updaters, so the recipe and the leave
    // guard's baseline hold the same cards. Its Remix needs no seeding: a
    // creation post's recipe includes it (S1).
    const prefilledCards: PostComposerResourceCardDraft[] = [];
    if (paywallPrefill.promptText) {
      prefilledCards.push(createCreationPromptCard(paywallPrefill.promptText));
    }
    if (paywallPrefill.notesMarkdown) {
      prefilledCards.push(createPostComposerResourceCard('guide', {
        textContent: paywallPrefill.notesMarkdown,
      }));
    }
    setResourceCards((current) => (current.length > 0 ? current : prefilledCards));
    setSavedSnapshot((saved) => ({
      ...saved,
      resourceCards: saved.resourceCards.length > 0 ? saved.resourceCards : prefilledCards,
    }));

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

        // The publish RPC upserts the post linked to this creation, so a
        // second "new post" from it silently overwrote the first (title,
        // caption, visibility) and dropped its recipe. The app redirects too.
        const linkedPostId = typeof generation.linked_post_id === 'string' ? generation.linked_post_id : null;
        if (!isEditMode && linkedPostId) {
          setLinkedPostRedirectId(linkedPostId);
          return;
        }

        const nextGeneration: GenerationDraft = {
          id: generation.id,
          title: typeof generation.title === 'string' ? generation.title : '',
          templateTitle: typeof generation.template?.templateTitle === 'string' ? generation.template.templateTitle : '',
          prompt: typeof generation.prompt === 'string' ? generation.prompt : '',
          creationMode: typeof generation.creationMode === 'string' ? generation.creationMode : null,
          outputUrl: typeof generation.output_url === 'string' ? generation.output_url : null,
          category: formatGeneratedCategory(generation.category),
          model: typeof generation.model === 'string' ? generation.model : 'magicbooklet',
          paywallPrefill: isGenerationPaywallPrefill(generation.paywallPrefill)
            ? generation.paywallPrefill
            : null,
          origin: generation.origin === 'template' ? 'template' : generation.origin === 'direct' ? 'direct' : null,
          // Counted the way the paywall prefill counts saved references.
          referenceCount: Array.isArray(generation.input_media)
            ? generation.input_media.filter((media: { storagePath?: unknown } | null) => (
              typeof media?.storagePath === 'string' && media.storagePath.length > 0
            )).length
            : 0,
          source: 'fetched',
        };

        setPrefilledGeneration(nextGeneration);
        setProofMode('media');
        setCategory(nextGeneration.category);
        // A template result shares its media only (the server refuses a recipe
        // on one), and its cards give way to a note once it is known: a recipe
        // picked while it was loading, when the cards were still up, goes too.
        const isTemplateResult = nextGeneration.origin === 'template';
        if (isTemplateResult && !isEditMode) {
          setResourceAccessMode('none');
        }
        // maxLength caps typing, not a programmatic prefill, so trim here too —
        // otherwise a long generation title submits over-limit and the server
        // rejects a post the composer never flagged. A new post of a creation
        // with no title starts from a suggestion, as the app composer does.
        const prefillTitle = isEditMode
          ? nextGeneration.title.slice(0, TITLE_MAX_LENGTH)
          : getCreationPostTitleSuggestion(
            nextGeneration.title || nextGeneration.templateTitle,
            {
              prompt: nextGeneration.prompt,
              model: nextGeneration.model,
              category: nextGeneration.category,
              creationMode: nextGeneration.creationMode,
            },
            // A paid recipe keeps the prompt out of the title; a free one does not (owner, 2026-10-29).
            recipeKeepsPromptPrivate(isTemplateResult ? 'none' : resourceAccessModeRef.current),
          )?.title ?? '';
        setTitle((current) => current || prefillTitle);
        // A new post's Made with is the creation's row from here on (it is
        // locked), and like the prefilled title it is where the post starts.
        const creationRow = isEditMode ? null : creationMadeWithRow(nextGeneration.model);
        if (creationRow) setMadeWithRows([creationRow]);
        setSavedSnapshot((saved) => ({
          ...saved,
          title: saved.title || prefillTitle,
          ...(creationRow ? { madeWith: snapshotMadeWith([creationRow]) } : {}),
        }));
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
  }, [generationId, generationLoadAttempt, isEditMode, session?.access_token]);

  // Its own effect: the router object is not a stable dependency for the
  // load above (a changing identity would refetch the generation forever).
  useEffect(() => {
    if (!linkedPostRedirectId) return;
    // The way back the composer was opened with goes along, so the editor's
    // Back still names the run or the Studio view it came from.
    const returnParams = new URLSearchParams();
    if (entrySurface) returnParams.set('from', entrySurface);
    const requestedReturnTo = searchParams.get('returnTo');
    if (requestedReturnTo) returnParams.set('returnTo', requestedReturnTo);
    const query = returnParams.toString();
    router.replace(`/post/${encodeURIComponent(linkedPostRedirectId)}/edit${query ? `?${query}` : ''}`);
  }, [entrySurface, linkedPostRedirectId, router, searchParams]);

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

  // Not a submit button: Enter in a field submits through the form's first
  // submit button, and on an edit that has to be the one that keeps the
  // post's visibility.
  const submitVisibilityChange = (targetVisibility: PostVisibility) => {
    submitWithVisibility(targetVisibility);
    formRef.current?.requestSubmit();
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

  // One controller per media item, keyed by item id, for both the add-time and
  // the publish-time upload: with one per batch, removing a file (or switching
  // to text) could not stop its bytes. Cancel still stops every file.
  const mediaUploadControllersRef = useRef(new Map<string, AbortController>());
  // Each added file's upload until it settles, so publish can wait for them. A
  // file leaves this map, and its wait settles, the moment it leaves the
  // composer: publish waited minutes on a removed 250 MB video.
  const activeEagerUploadsRef = useRef(new Map<string, { settled: Promise<void>; settle: () => void }>());
  // Per-file progress, summed into the one bar. A removed or failed file drops
  // out, so the bar stops counting bytes nobody is waiting for; a finished one
  // stays counted until the last lands, so the bar does not jump backwards.
  const eagerProgressRef = useRef(new Map<string, { bytesSent: number; totalBytes: number; done: boolean }>());
  // Staged paths keyed by item id. Publish reads this rather than waiting for the
  // setMediaItems below to round-trip through React — resuming from an awaited
  // upload does not guarantee the new state has committed, and reading it too
  // early made publish upload the same file a second time.
  const stagedPathsRef = useRef(new Map<string, string>());
  // An edit save that sends media re-inserts every media row of the post under
  // a new id, so the ids this page holds stop naming them. The save's answer
  // lists the new rows; when it does not (a server from before it did, or a
  // save that failed after it may have written), the next save reads them back.
  const savedMediaRowsStaleRef = useRef(false);

  const publishCombinedEagerProgress = () => {
    const files = [...eagerProgressRef.current.values()];
    if (files.every((file) => file.done)) {
      eagerProgressRef.current.clear();
      setUploadProgress(null);
      return;
    }
    const totals = files.reduce(
      (sum, file) => ({
        bytesSent: sum.bytesSent + file.bytesSent,
        totalBytes: sum.totalBytes + file.totalBytes,
        completed: sum.completed + (file.done ? 1 : 0),
        total: sum.total + 1,
      }),
      { bytesSent: 0, totalBytes: 0, completed: 0, total: 0 },
    );
    setUploadProgress({
      ...totals,
      percent: totals.totalBytes > 0 ? Math.round((totals.bytesSent / totals.totalBytes) * 100) : 0,
    });
  };

  const startMediaUpload = (itemId: string) => {
    const controller = new AbortController();
    mediaUploadControllersRef.current.set(itemId, controller);
    return controller;
  };

  const finishMediaUpload = (itemId: string, controller: AbortController) => {
    if (mediaUploadControllersRef.current.get(itemId) === controller) {
      mediaUploadControllersRef.current.delete(itemId);
    }
  };

  // Ids of media taken out of the composer. A publish already under way holds
  // the list as it was when clicked, and must not upload or submit these.
  const removedMediaIdsRef = useRef(new Set<string>());

  // For media leaving the composer: its upload stops, and publish stops waiting.
  const abortMediaUploads = (itemIds: string[]) => {
    let droppedProgress = false;
    for (const itemId of itemIds) {
      removedMediaIdsRef.current.add(itemId);
      mediaUploadControllersRef.current.get(itemId)?.abort();
      mediaUploadControllersRef.current.delete(itemId);
      activeEagerUploadsRef.current.get(itemId)?.settle();
      activeEagerUploadsRef.current.delete(itemId);
      droppedProgress = eagerProgressRef.current.delete(itemId) || droppedProgress;
    }
    // Only when an add-time entry went: a publish-time upload owns the bar then.
    if (droppedProgress) {
      publishCombinedEagerProgress();
    }
  };

  const uploadAddedMedia = async (added: ComposerMediaItem[]) => {
    const uploadable = added.filter((item) => item.file);
    if (uploadable.length === 0) {
      return;
    }

    const controllers = new Map<string, AbortController>();
    const waits = new Map<string, { settled: Promise<void>; settle: () => void }>();
    for (const item of uploadable) {
      controllers.set(item.id, startMediaUpload(item.id));
      const wait = createUploadWait();
      waits.set(item.id, wait);
      activeEagerUploadsRef.current.set(item.id, wait);
      eagerProgressRef.current.set(item.id, { bytesSent: 0, totalBytes: item.file?.size ?? 0, done: false });
    }
    publishCombinedEagerProgress();

    const result = await runWeightedUploadQueue(
      uploadable.map((item) => ({ item, kind: item.mediaKind })),
      async (item) => {
        const controller = controllers.get(item.id)!;
        try {
          if (controller.signal.aborted) {
            throw new UploadCancelledError();
          }
          const media = await uploadMediaToTemporaryStorage(item.file!, {
            signal: controller.signal,
            onProgress: ({ bytesSent, totalBytes }) => {
              const progress = eagerProgressRef.current.get(item.id);
              if (!progress) return;
              eagerProgressRef.current.set(item.id, { ...progress, bytesSent, totalBytes });
              publishCombinedEagerProgress();
            },
          });
          if (controller.signal.aborted) {
            throw new UploadCancelledError();
          }
          // Stamped as each file lands, before its wait settles, so a publish
          // waiting on it reads the path; carrying one is what makes publish
          // skip the file.
          stagedPathsRef.current.set(item.id, media.storagePath);
          setMediaItems((current) => current.map((candidate) => (
            candidate.id === item.id ? { ...candidate, storagePath: media.storagePath } : candidate
          )));
          const progress = eagerProgressRef.current.get(item.id);
          if (progress) {
            eagerProgressRef.current.set(item.id, { ...progress, bytesSent: progress.totalBytes, done: true });
          }
          return media.storagePath;
        } catch (uploadError) {
          eagerProgressRef.current.delete(item.id);
          // An aborted fetch rejects with its own AbortError; it is still a cancel.
          throw controller.signal.aborted ? new UploadCancelledError() : uploadError;
        } finally {
          finishMediaUpload(item.id, controller);
          const wait = waits.get(item.id)!;
          wait.settle();
          if (activeEagerUploadsRef.current.get(item.id) === wait) {
            activeEagerUploadsRef.current.delete(item.id);
          }
          publishCombinedEagerProgress();
        }
      },
    );

    // Say so now rather than at publish. A failed file keeps its File and
    // publish tries it again, but the server refuses some files outright (too
    // large, wrong type), so the message gives the reason rather than promise
    // a retry that cannot succeed.
    const failures = result.failures.filter((failure) => !isUploadCancelledError(failure.error));
    if (failures.length > 0) {
      const failedNames = failures
        .map((failure) => failure.item.originalName ?? failure.item.file?.name)
        .filter(Boolean)
        .join(', ');
      const firstError = failures[0].error;
      const reason = firstError instanceof Error && firstError.message
        ? firstError.message
        : 'Remove it, or publish to try again.';
      setError({
        section: 'post',
        message: `${failures.length} of ${uploadable.length} uploads failed${failedNames ? ` (${failedNames})` : ''}. ${reason}`,
      });
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
      const durationSeconds = await readVideoDurationSeconds(candidate);
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
    abortMediaUploads([id]);
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
    abortMediaUploads(mediaItems.map((item) => item.id));
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
      const node = target.current;
      if (!node) {
        return;
      }
      // The message rather than the section's top: a section holding media is
      // taller than a phone's screen.
      const message = node.querySelector('[role="alert"]');
      (message ?? node).scrollIntoView({ behavior: 'smooth', block: message ? 'center' : 'start' });
      node.focus({ preventScroll: true });
    });
  };

  /**
   * Upload every not-yet-staged media item, reporting aggregate byte progress.
   *
   * Runs through the weighted queue rather than `Promise.all` so one failure
   * cannot discard files that already uploaded. Items keep their composer order
   * because the first one is the Showcase cover.
   */
  const uploadComposerMedia = async (items: ComposerMediaItem[]) => {
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

    const controllers = new Map(pending.map((item) => [item.id, startMediaUpload(item.id)]));

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

          const controller = controllers.get(item.id)!;
          if (controller.signal.aborted) {
            throw new UploadCancelledError();
          }
          let media: Awaited<ReturnType<typeof uploadMediaToTemporaryStorage>>;
          try {
            media = await uploadMediaToTemporaryStorage(item.file, {
              signal: controller.signal,
              onProgress: ({ bytesSent, totalBytes }) => {
                bytesByIndex.set(index, { bytesSent, totalBytes });
                publishProgress();
              },
            });
          } catch (uploadError) {
            // An aborted fetch rejects with its own AbortError; it is still a cancel.
            throw controller.signal.aborted ? new UploadCancelledError() : uploadError;
          }

          completed += 1;
          publishProgress();
          return {
            storagePath: media.storagePath,
            contentType: item.file.type,
            originalName: item.file.name,
          };
        },
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
      controllers.forEach((controller, itemId) => finishMediaUpload(itemId, controller));
      setUploadProgress(null);
    }
  };

  const cancelMediaUpload = () => {
    // Every file still uploading, add-time or publish-time. The files stay in
    // the composer, and publish uploads them again.
    mediaUploadControllersRef.current.forEach((controller) => controller.abort());
  };

  /**
   * Forget staged paths once a save may have consumed them.
   *
   * The server moves a staged file into the post and then deletes it, so after
   * a network error, a 5xx, or a refusal raised after that move, the retry has
   * to upload again: reusing a consumed path fails on every attempt. Any other
   * refusal (title, quality, safety, profile) is decided before a staged file is
   * touched, and keeping the paths is what lets a fix-and-retry skip the upload.
   */
  const forgetStagedMediaPaths = () => {
    // The add-time cache has to go too, or publish would re-apply the very paths
    // the server just consumed and the retry could never recover.
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

  const toggleCreationPrompt = (include: boolean) => {
    if (include) {
      const promptCard = createCreationPromptCard(creationPrompt);
      setResourceCards((current) => (
        current.some((card) => isCreationPromptCard(card, creationPrompt)) ? current : [...current, promptCard]
      ));
    } else {
      setResourceCards((current) => current.filter((card) => !isCreationPromptCard(card, creationPrompt)));
    }
    resetFeedback();
  };

  // Removing the last item keeps the recipe's mode (H2, 2026-10-27): it used
  // to switch to No recipe by itself, which an edit's save then deleted.
  // Publish asks for an item instead, as the app does.
  const removeResourceCard = (id: string) => {
    setResourceCards((current) => current.filter((card) => card.id !== id));
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
      throw new Error('Sign in again to upload files.');
    }
    return uploadResourceFile(file, session.access_token, options);
  };

  // An edit stays on this page once saved. Its panel is drawn at the end of the
  // form, and the phone bar that pressed save hides itself.
  useEffect(() => {
    if (!createdPost || !isEditMode) {
      return;
    }
    savedPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    savedPanelRef.current?.focus({ preventScroll: true });
  }, [createdPost, isEditMode]);

  const completePublish = (nextPost: CreatedPostState) => {
    setCreatedPost(nextPost);
    setStoredRecipe({
      accessMode: nextPost.resourceAccessMode,
      itemCount: nextPost.resourceAccessMode === 'none' ? 0 : readyResourceCards.length,
    });
    // The form as it was submitted is now what the server holds; anything typed
    // while the save was in flight still counts as unsaved. The visibility comes
    // from the press, which set it in the same click this snapshot may predate.
    setSavedSnapshot({ ...composerSnapshot, visibility: submitVisibilityRef.current });
    trackProductEvent(isEditMode ? 'post_update_success' : 'post_publish_success', {
      visibility: nextPost.visibility,
      recipe_access: nextPost.resourceAccessMode,
      entry_surface: entrySurface ?? 'direct',
    });
    // Studio's copy of its creations and posts is stale now: it reads them afresh.
    forgetCreationsWorkspaceCache(session?.user?.id);
  };

  // A new post takes the composer's place in history, as the app's composer
  // leaves its stack: Back from the post returns to where the composer was
  // opened from, and the post's own way back names that place. Someone who left
  // the composer while the post was being sent is not taken anywhere.
  const leaveForPublishedPost = (nextPost: CreatedPostState) => {
    if (!isMountedRef.current) return;
    const ownerReturn = new URLSearchParams({ returnTo: backHref });
    if (entrySurface) ownerReturn.set('from', entrySurface);
    const nextPath = nextPost.showcasePath
      ? buildShowcaseDetailPath(nextPost.postId, { returnTo: backHref })
      : `${nextPost.ownerPath}?${ownerReturn.toString()}`;
    // Through the guard, so no guard entry is left under the post for Back
    // to land on.
    leaveComposer(() => router.replace(nextPath));
  };

  // A template run's "Publish & share", as the app's: the post's own address,
  // once it is public. A share that is dismissed or cannot run never reads as a
  // failed publish; a copied link, or a share that could not open, says so.
  const sharePublishedPost = async (nextPost: CreatedPostState) => {
    try {
      const channel = await sharePublicGeneration({
        // A post's id opens its page and counts its share, as a creation's does.
        generationId: nextPost.postId,
        title: title.trim(),
        sourceSurface: 'my-creations',
        accessToken: session?.access_token ?? null,
        viewerIsOwner: true,
      });
      if (channel === 'copy-link') {
        pushToast({ tone: 'success', message: 'Post link copied.' });
      }
    } catch (shareError) {
      console.error('Published the post, but sharing was unavailable:', shareError);
      pushToast({ tone: 'info', message: 'Your post is published. Share it from its page.' });
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

    // Only a text post gets here without media.
    if (!trimmedBody && !hasMediaProof) {
      stopWithError('Write the post text before publishing.', 'story');
      return;
    }

    if (mediaItems.some((item) => item.contentType?.startsWith('audio/'))) {
      stopWithError('Audio posts are not supported in Explore yet.', 'post');
      return;
    }

    if (bodyCount > BODY_MAX_LENGTH) {
      stopWithError(`${bodyFieldLabel} is limited to ${BODY_MAX_LENGTH} characters.`, 'story');
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
        // The title's half of the rule is answered beside the title.
        stopWithError(publicPostQualityError, publicPostQualityError === PUBLIC_POST_PLACEHOLDER_TITLE_ERROR ? 'post' : 'story');
        return;
      }

      if (needsPublicIdentity) {
        const identityProblems = validatePublicIdentity(identity, composerProfile?.username);
        if (identityProblems.displayName || identityProblems.username) {
          setIdentityErrors(identityProblems);
          stopWithError('Add your name and handle to publish publicly.', 'publish');
          return;
        }
      }
    }

    let resourceBundle: PostResourceBundleInput | undefined;
    // Every recipe is checked and sent, one people have bought included (D1):
    // its edits are a new version, and they keep the one they got.
    if (resourceAccessMode !== 'none') {
      // At least one item (S1): Remix is no item, and a creation's saved
      // inputs ticked above are one (A-F9).
      if (!hasResourceContent && !includesCreationReferences) {
        stopWithError(RECIPE_EMPTY_ERROR, 'resources');
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
        stopWithError(RECIPE_PRICE_ERROR, 'resources');
        return;
      }

      // Suggested from the items, but required: a creator who clears it is
      // asked for it.
      if (!resourcePreviewText.trim()) {
        stopWithError(RECIPE_PREVIEW_REQUIRED_ERROR, 'resources');
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

      // A recipe of the creation's saved inputs alone is sent without items:
      // the publish route adds them, so the listing rule's own item check is
      // the server's to make.
      const listingIssues = submittedMarketplaceAssessment.issues.filter((issue) => (
        !(issue.code === 'missing_resources' && includesCreationReferences)
      ));
      if (!submittedMarketplaceAssessment.eligible && listingIssues.length > 0) {
        const firstIssue = listingIssues[0];
        stopWithError(
          firstIssue?.code === 'missing_preview'
            ? RECIPE_PREVIEW_QUALITY_ERROR
            : `Improve this recipe before publishing: ${firstIssue?.message ?? 'Finish the marketplace checklist.'}`,
          firstIssue?.field === 'title' ? 'post' : firstIssue?.field === 'post' ? 'story' : 'resources',
        );
        return;
      }

      resourceBundle = resourceBundleDraft ?? undefined;
    }

    // H2 (2026-10-27): an edit's save that takes the recipe off deletes it and
    // its files (or retires it, when people have it), so it asks first.
    if (isEditMode && storedRecipe.accessMode !== 'none' && resourceAccessMode === 'none') {
      const removes = await askToConfirm(getRecipeRemovalQuestion(storedRecipe.itemCount, recipeBuyerCount, recipeIncludesRemix));
      if (!removes) {
        return;
      }
    }

    try {
      setIsSubmitting(true);
      if (effectiveVisibility === 'public' && needsPublicIdentity) {
        const saved = await claimPublicIdentity(identity, session.access_token);
        if (!saved.ok) {
          setIdentityErrors(saved.errors);
          // Through the catch, so the attempt is counted as failed, as the
          // server's own refusal for the profile was.
          throw new ComposerSubmissionError(saved.message, 'publish');
        }
        setComposerProfile({ username: saved.profile.username, displayName: saved.profile.displayName });
        setProfileRefused(false);
        setIdentityErrors({});
      }
      // An add-time upload may still be running. Letting it finish means its
      // storagePath is already stamped, so publish skips that file instead of
      // uploading it a second time.
      // Loop, not a single await: a new file can start uploading while earlier
      // ones are being awaited, and publish must not proceed until every one
      // has settled. A file removed meanwhile settles at once and is left out.
      while (activeEagerUploadsRef.current.size > 0) {
        await Promise.all([...activeEagerUploadsRef.current.values()].map((wait) => wait.settled));
      }
      let itemsWithStagedPaths = mediaItems
        .filter((item) => !removedMediaIdsRef.current.has(item.id))
        .map((item) => (
          !item.storagePath && stagedPathsRef.current.has(item.id)
            ? { ...item, storagePath: stagedPathsRef.current.get(item.id)! }
            : item
        ));
      if (savedMediaRowsStaleRef.current && isEditMode && initialPost && !generationId) {
        const savedRows = await readBackSavedMediaRows(initialPost.id, session.access_token);
        savedMediaRowsStaleRef.current = false;
        itemsWithStagedPaths = withSavedMediaRows(itemsWithStagedPaths, savedRows);
        setMediaItems((current) => withSavedMediaRows(current, savedRows));
      }
      const mediaItemsForSubmit = generationId
        ? undefined
        : await uploadComposerMedia(itemsWithStagedPaths);

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
            isNsfw,
            title: title.trim() || undefined,
            body: trimmedBody || undefined,
            category: inferredCategory ?? undefined,
            sourceTools: sourceToolsForSubmit.length > 0 ? sourceToolsForSubmit : undefined,
            resourceBundle: resourceBundle ?? { accessMode: 'none' },
            // The server copies the inputs only into a recipe that is sent.
            ...(includesCreationReferences && resourceBundle
              ? { includeGenerationReferences: true }
              : {}),
          }),
        });

        const data = await readResponseBody(response);

        if (!response.ok || !data.success) {
          throw getSubmissionError(data, 'Failed to publish post.');
        }

        const published: CreatedPostState = {
          postId: data.postId as string,
          showcasePath: (data.showcasePath as string | null) ?? null,
          ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
          resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
          visibility: data.visibility as PostVisibility,
          resourceAccessMode,
          resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
            ? data.resourceBundleStatus
            : null,
        };
        // Recorded before the share, which can stay open as long as it likes:
        // the post exists from here on.
        completePublish(published);
        if (sharesAfterPublish && published.visibility === 'public' && isMountedRef.current) {
          await sharePublishedPost(published);
        }
        leaveForPublishedPost(published);

        return;
      }

      if (isEditMode && initialPost) {
        // A text post has none to send, and an empty list is refused (the app
        // sends none either).
        const sendsMedia = Boolean(mediaItemsForSubmit?.length);
        let response: Response;
        try {
          response = await fetch(`/api/posts/${initialPost.id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              title: title.trim() || null,
              body: trimmedBody || null,
              sourceTools: sourceToolsForSubmit.length > 0 ? sourceToolsForSubmit : undefined,
              visibility: effectiveVisibility,
              isNsfw,
              category: inferredCategory ?? undefined,
              ...(sendsMedia ? { mediaItems: mediaItemsForSubmit } : {}),
              // Always sent: the update path keeps what is stored for a
              // missing key, so No recipe has to say `{accessMode:'none'}`
              // (asked about above).
              resourceBundle: resourceBundle ?? { accessMode: 'none' },
            }),
          });
        } catch (networkError) {
          // The request may have reached the server and consumed its staged
          // media, so the safe assumption is that the paths are gone.
          forgetStagedMediaPaths();
          if (sendsMedia) savedMediaRowsStaleRef.current = true;
          throw networkError;
        }

        const { data, stagedMediaConsumed } = await readSaveResponse(response);
        if (stagedMediaConsumed) {
          forgetStagedMediaPaths();
          // A failure after the write leaves the rows re-inserted too.
          if (sendsMedia) savedMediaRowsStaleRef.current = true;
        }
        // Refused before anything was written, for ids the post's rows no longer
        // have (an earlier save that finished late, or an edit from the app):
        // the uploads are untouched, and the next save reads the rows back.
        if (!response.ok && data.field === 'mediaItems' && sendsMedia) {
          savedMediaRowsStaleRef.current = true;
        }
        if (!response.ok || !data.success) {
          throw getSubmissionError(data, 'Failed to save post.');
        }

        if (sendsMedia) {
          const savedRows = readSavedMediaRows(data.mediaItems);
          const sentIds = new Set(itemsWithStagedPaths.map((item) => item.id));
          sentIds.forEach((id) => stagedPathsRef.current.delete(id));
          savedMediaRowsStaleRef.current = !savedRows;
          setMediaItems((current) => {
            // Media added while this save was on its way keeps its own upload.
            const sent = current.map((item) => (sentIds.has(item.id) ? { ...item, storagePath: null } : item));
            return savedRows ? withSavedMediaRows(sent, savedRows) : sent;
          });
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
      formData.set('isNsfw', String(isNsfw));
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
        // The request may have reached the server and consumed its staged
        // media, so the safe assumption is that the paths are gone.
        forgetStagedMediaPaths();
        throw networkError;
      }
      // A refusal such as a placeholder title keeps the staged paths, so the
      // fixed retry sends them again instead of uploading every file anew.
      const { data, stagedMediaConsumed } = await readSaveResponse(response);
      if (stagedMediaConsumed) {
        forgetStagedMediaPaths();
      }
      if (!response.ok) {
        throw getSubmissionError(data, 'Failed to publish post.');
      }

      const published: CreatedPostState = {
        postId: data.postId as string,
        showcasePath: (data.showcasePath as string | null) ?? null,
        ownerPath: (data.ownerPath as string | null) ?? `/post/${data.postId as string}/edit`,
        resourceBundlePath: (data.resourceBundlePath as string | null) ?? null,
        visibility: data.visibility as PostVisibility,
        resourceAccessMode,
        resourceBundleStatus: data.resourceBundleStatus === 'draft' || data.resourceBundleStatus === 'published'
          ? data.resourceBundleStatus
          : null,
      };
      completePublish(published);
      leaveForPublishedPost(published);
    } catch (submitError) {
      const section = submitError instanceof ComposerSubmissionError ? submitError.section : 'publish';
      trackProductEvent(isEditMode ? 'post_update_failed' : 'post_publish_failed', {
        visibility: effectiveVisibility,
        recipe_access: resourceAccessMode,
        error_section: section,
      });
      setError({
        section,
        message: submitError instanceof Error ? submitError.message : 'Failed to publish post.',
        actionHref: submitError instanceof ComposerSubmissionError ? submitError.actionHref : undefined,
        actionLabel: submitError instanceof ComposerSubmissionError ? submitError.actionLabel : undefined,
      });
      // Refused for the profile: ask for the name and handle here, beside the
      // link to the profile.
      if (submitError instanceof ComposerSubmissionError && submitError.actionHref === buildProfileRepairHref()) {
        setProfileRefused(true);
      }
      // The server refuses a post-section field only over Made With, whose
      // rows are folded away by default.
      if (section === 'post') {
        setIsMadeWithOpen(true);
      }
      // The bar that pressed publish can be a screen away from the section.
      focusComposerSection(section);
    } finally {
      setIsSubmitting(false);
    }
  };

  const createdPostHasResources = createdPost ? createdPost.resourceAccessMode !== 'none' : false;
  // On an edit, the owner path is the page already open.
  const primaryPostPath = createdPost?.showcasePath ?? (isEditMode ? null : createdPost?.ownerPath ?? null);
  const primaryPostLabel = createdPost?.resourceBundleStatus === 'draft'
    ? 'Continue editing'
    : createdPost?.showcasePath
      ? 'View post'
      : 'Open editor';
  // Where the editor was opened from wins; edit mode's own default is Studio.
  // The seller dashboard's edit links carry `from=seller`, and used to read
  // "Back to studio" over a link that returned to /marketplace/sell.
  const fallbackBackHref = entrySurface === 'profile'
    ? '/profile?tab=posts'
    : entrySurface === 'marketplace'
      ? '/marketplace'
      : entrySurface === 'seller'
        ? '/marketplace/sell'
        : entrySurface === 'home'
          ? '/'
          : entrySurface === 'template-run'
            ? '/templates'
            : isEditMode || entrySurface === 'creations'
              ? '/creations?view=posts'
              : '/showcase';
  const backHref = getSafeInternalReturnPath(searchParams.get('returnTo'), fallbackBackHref);
  const backLabel = entrySurface === 'profile'
    ? 'Back to profile'
    : entrySurface === 'marketplace'
      ? 'Back to marketplace'
      : entrySurface === 'seller'
        ? 'Back to Recipe sales'
        : entrySurface === 'home'
          ? 'Back to home'
          : entrySurface === 'template-run'
            ? 'Back to template run'
            : isEditMode || entrySurface === 'creations'
              ? 'Back to studio'
              : 'Back to Explore';
  // A new post is saved private or published public. An edit keeps the post's
  // visibility with Save changes, and the other button is the one that changes it.
  const primarySubmit: { target: PostVisibility; label: string; detail: string } = isEditMode
    ? {
        target: savedVisibility,
        label: 'Save changes',
        detail: savedVisibility === 'public' ? 'Stays visible in Explore.' : 'Stays private in Studio.',
      }
    : { target: 'public', label: 'Publish public', detail: 'Visible in Explore.' };
  const secondarySubmit: { target: PostVisibility; label: string; detail: string } = !isEditMode
    ? { target: 'private', label: 'Save private', detail: 'Saved privately in Studio.' }
    : savedVisibility === 'public'
      ? { target: 'private', label: 'Make private', detail: 'Saved privately in Studio.' }
      : { target: 'public', label: 'Publish publicly', detail: 'Visible in Explore.' };
  const pressSecondarySubmit = () => (
    isEditMode ? submitVisibilityChange(secondarySubmit.target) : submitWithVisibility(secondarySubmit.target)
  );
  // A press sets the visibility it submits with, so the one in flight is the
  // button whose target matches.
  const getPendingLabel = (target: PostVisibility) => {
    if (!isSubmitting || visibility !== target) {
      return null;
    }
    return target === 'public' && !(isEditMode && savedVisibility === 'public') ? 'Publishing…' : 'Saving…';
  };
  const primaryPendingLabel = getPendingLabel(primarySubmit.target);
  const secondaryPendingLabel = getPendingLabel(secondarySubmit.target);

  return (
    <div className="ui-page ui-page-ambient min-h-screen">
      {/* Enter in a field submits through the form's first submit button in
          document order, which was the phone bar's "Save private": a title
          and Enter saved a new post privately and left the page. A disabled
          first button makes Enter do nothing on a new post, where both actions
          decide who sees it; an edit's first is "Save changes", which keeps
          the post's visibility. */}
      {!isEditMode ? (
        <button type="submit" form="post-composer-form" disabled hidden aria-hidden="true" tabIndex={-1} />
      ) : null}
      <div className="fixed inset-0 hidden pointer-events-none">
        <div className="absolute left-[-10%] top-[-8%] h-[40%] w-[32%] rounded-full bg-sky-500/12 blur-[140px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[36%] w-[30%] rounded-full bg-emerald-500/10 blur-[160px]" />
      </div>

      {!createdPost ? (
        // Above the app shell's bottom navigation, which floats over the page's
        // bottom edge below 768px (z-60): at `bottom-4` the nav was drawn over
        // both buttons, so a phone could not save or publish.
        <div className="fixed inset-x-4 bottom-[calc(var(--app-shell-bottom-nav-space,0px)+1rem)] z-40 lg:hidden">
          <div className="flex items-center gap-3 rounded-[24px] border border-white/10 bg-zinc-950/95 p-3 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
            <button
              type={isEditMode ? 'button' : 'submit'}
              form={isEditMode ? undefined : 'post-composer-form'}
              disabled={isSubmitting || isLoadingGeneration}
              onClick={pressSecondarySubmit}
              className="inline-flex flex-1 shrink-0 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {secondaryPendingLabel ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {secondaryPendingLabel ?? secondarySubmit.label}
            </button>
            <button
              type="submit"
              form="post-composer-form"
              disabled={isSubmitting || isLoadingGeneration}
              onClick={() => submitWithVisibility(primarySubmit.target)}
              className="ui-focus-ring inline-flex min-h-12 flex-1 shrink-0 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {primaryPendingLabel
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : isEditMode ? <Check className="h-4 w-4" /> : <BadgePlus className="h-4 w-4" />}
              {primaryPendingLabel ?? primarySubmit.label}
            </button>
          </div>
        </div>
      ) : null}

      {/* Below 1024px the page's end scrolls clear of the phone bar over it (7rem). */}
      <div className="studio-shell relative z-10 pt-12 pb-28 sm:pt-16 lg:pb-16">
        <Link
          href={backHref}
          // The leave guard holds this link's click like any other while there
          // is unsaved work, so it needs no question of its own.
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </Link>

        <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
          <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm sm:p-6">
            <div className="mb-6">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                {isRecipeAddIntent
                  ? 'Add a recipe to this post'
                  : isCreationPaywallManagementIntent
                    ? 'Manage the recipe behind this post'
                    : isEditMode
                      ? 'Update post'
                      : 'Create post'}
              </h1>
              <p className="mt-2 text-sm text-zinc-400">
                {isRecipeAddIntent
                  ? 'Choose a free or paid recipe, then add what people receive.'
                  : isCreationPaywallManagementIntent
                    ? 'Adjust post settings, pricing, and visibility below.'
                    : isGeneratedPaywallIntent
                      ? 'Your media is attached. Complete the optional recipe details below.'
                      : isEditMode
                        ? 'Edit post content, visibility, and recipe settings.'
                        : 'Share your work and add an optional reusable recipe.'}
              </p>
            </div>

            {/* noValidate: the browser's own bubble (a price of 95 against step=10)
                blocked submit before the composer could name the rule. */}
            <form
              id="post-composer-form"
              ref={formRef}
              noValidate
              className="space-y-6 pb-28 lg:pb-0"
              onSubmit={handleSubmit}
              // Enter on a checkbox or radio never submits: Chrome's implicit
              // submission skips the disabled first button above for a non-text
              // control and clicks the next one, the phone bar's "Save private"
              // (a title and Enter stop at that button; a NSFW tick and Enter
              // saved the post privately and left the page).
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const target = event.target;
                if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
                  event.preventDefault();
                }
              }}
            >
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
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-white">Media</h2>
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
                    {!hasGeneratedProof && generationId && isLoadingGeneration ? (
                      // The creation is still loading: no drop zone, which read
                      // as "upload something" and whose files the publish ignored.
                      <div className="flex min-h-[240px] items-center justify-center rounded-[28px] border border-white/10 bg-white/[0.02]" aria-busy="true" aria-label="Loading your creation">
                        <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
                      </div>
                    ) : !hasGeneratedProof && generationId && generationError ? (
                      <div role="alert" className="rounded-[28px] border border-rose-500/20 bg-rose-500/5 p-5">
                        <div className="text-sm font-semibold text-rose-100">Could not load this creation</div>
                        <p className="mt-1.5 text-sm leading-6 text-rose-100/80">{generationError}</p>
                        <button
                          type="button"
                          onClick={() => setGenerationLoadAttempt((current) => current + 1)}
                          className="mt-4 inline-flex min-h-11 items-center rounded-full border border-rose-300/30 px-4 text-xs font-bold text-rose-50 transition hover:bg-rose-500/10"
                        >
                          Retry
                        </button>
                      </div>
                    ) : hasGeneratedProof ? (
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
                              <InlineMediaVideo
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
                              <p className="mt-1 text-xs text-zinc-400">The first item is the Explore cover.</p>
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
                              <InlineMediaVideo
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
                                    <InlineMediaVideo
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
                          Write your tip or guide in Post text below.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {renderSectionError('post')}

                <label className="mt-6 block border-t border-white/8 pt-5">
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
                    placeholder="What is this creation about?"
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                  {titleSuggestionHint ? (
                    <span className="mt-2 block text-xs leading-5 text-zinc-500">{titleSuggestionHint}</span>
                  ) : null}
                </label>

                {proofMode === 'media' ? (
                  <div className="mt-5">
                    <button
                      type="button"
                      aria-expanded={isMadeWithOpen}
                      aria-controls={isMadeWithOpen ? madeWithPanelId : undefined}
                      onClick={() => setIsMadeWithOpen((open) => !open)}
                      className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:bg-white/[0.06]"
                    >
                      <Sparkles className="h-5 w-5 shrink-0 text-sky-200" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-white">
                          Made with <span className="font-normal text-zinc-500">Optional</span>
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-zinc-400">{madeWithSummary}</span>
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150 ${isMadeWithOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {isMadeWithOpen ? (
                      <div id={madeWithPanelId} className="mt-3 rounded-[24px] border border-sky-300/15 bg-sky-400/5 p-4">
                        <p className="max-w-2xl text-sm leading-6 text-zinc-300">
                          Add the tool and model you used.{hasGeneratedProof ? ' magicbooklet is already set.' : ''}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-zinc-500">
                          Popular tools appear first. Search to find more editors, workflows, API platforms, or older tools.
                        </p>
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
                  </div>
                ) : null}
              </div>

              <div
                ref={storySectionRef}
                tabIndex={-1}
                data-composer-section="story"
                className="rounded-3xl border border-white/8 bg-black/20 p-5 outline-none"
              >
                <label className="block">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                      {bodyFieldLabel}{' '}
                      {proofMode === 'text'
                        ? <span className="text-sky-300">Required</span>
                        : <span className="font-normal normal-case tracking-normal text-zinc-600">Optional</span>}
                    </span>
                    {/* aria-hidden for the same reason as the title's counter. */}
                    <span
                      aria-hidden="true"
                      className={`text-xs ${bodyCount > BODY_MAX_LENGTH ? 'text-rose-300' : 'text-zinc-500'}`}
                    >
                      {bodyCount}/{BODY_MAX_LENGTH}
                    </span>
                  </div>
                  <textarea
                    value={body}
                    onChange={(event) => {
                      setBody(event.target.value);
                      resetFeedback();
                    }}
                    aria-label={`${bodyFieldLabel}, ${proofMode === 'text' ? 'required' : 'optional'}, maximum ${BODY_MAX_LENGTH} characters`}
                    aria-required={proofMode === 'text' ? 'true' : undefined}
                    placeholder={
                      proofMode === 'text'
                        ? 'Share a prompt, idea, breakdown, or useful note…'
                        : 'Share the idea, process, or story behind it…'
                    }
                    rows={proofMode === 'text' ? 8 : 6}
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {renderSectionError('story')}
              </div>

              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border border-white/10 p-4 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={isNsfw}
                  onChange={(event) => {
                    setIsNsfw(event.target.checked);
                    resetFeedback();
                  }}
                  className="mt-1"
                />
                <span><span className="block font-semibold">Mark as NSFW / mature</span><span className="mt-1 block text-zinc-400">Cover this post’s media and text until viewers choose to reveal them. Community rules still apply.</span></span>
              </label>
              <div
                id="recipe"
                ref={resourceSectionRef}
                tabIndex={-1}
                data-composer-section="resources"
                className="rounded-3xl border border-emerald-500/15 bg-emerald-500/5 p-5 outline-none"
              >
                <span id="resources" aria-hidden className="sr-only" />
                <div>
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-lg font-semibold text-white">Recipe</h2>
                    <span className="text-xs font-medium text-zinc-500">Optional</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">
                    Share the prompt, files, links, or notes behind this post, free or for credits.
                  </p>
                </div>

                {isGeneratedPaywallIntent ? (
                  <div className="mt-5 rounded-[24px] border border-emerald-300/18 bg-black/30 p-4 text-sm leading-6 text-zinc-200">
                    {isLoadingGeneration
                      ? 'Preparing the saved prompt and generation setup for this paid recipe.'
                      : hasGenerationPaywallPrefill
                        ? 'Saved prompt, reusable setup notes, and remix access are ready where this creation supports them. Set the price first, then publish or edit anything below.'
                        : 'This creation does not have enough saved inputs to auto-fill a paid recipe yet. The media is still attached, and you can add the prompt or notes as items below.'}
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

                {prefilledGeneration?.origin === 'template' ? (
                  // The server refuses a recipe on a template result at publish
                  // time; say so here, as the app does, instead of after the form.
                  <div className="mt-4 rounded-[24px] border border-white/8 bg-black/25 px-4 py-3 text-sm text-zinc-200">
                    This template result shares final media only. Its private recipe remains protected.
                  </div>
                ) : (
                  <RecipeAccessCards
                    value={resourceAccessMode}
                    onChange={(nextMode) => {
                      changeResourceAccessMode(nextMode);
                      // A focus request from Studio is for the mode the page
                      // opened in: on a free recipe opened at the price, an
                      // arrow from Free to Paid must not pull the focus into
                      // the price field, where the next arrow changes the price.
                      setDidFocusPriceInput(true);
                      if (nextMode !== 'none') {
                        trackProductEvent('recipe_access_mode_selected', {
                          access_mode: nextMode,
                          entry_surface: entrySurface ?? 'direct',
                        });
                      }
                      resetFeedback();
                    }}
                  />
                )}

                {resourceAccessMode !== 'none' ? (
                  <div className="mt-5 space-y-5">
                    {resourceAccessMode === 'paid' ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/25 p-4 space-y-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Price</span>
                          <div className="relative inline-flex items-center">
                            <input
                              ref={priceInputRef}
                              type="number"
                              inputMode="numeric"
                              min={POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS}
                              step={POST_RESOURCE_PRICE_INCREMENT_USD_CENTS}
                              aria-label="Price in credits"
                              aria-describedby={recipeMoneyLineId}
                              placeholder={String(DEFAULT_PRICE_TOKENS)}
                              value={resourcePriceTokens}
                              onChange={(event) => {
                                setResourcePriceTokens(event.target.value);
                                resetFeedback();
                              }}
                              className="w-28 rounded-full border border-white/10 bg-white/[0.03] pl-3 pr-16 py-1 text-center text-xs font-semibold text-white outline-none focus:border-emerald-300/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            />
                            <span className="pointer-events-none absolute right-3 text-xs text-zinc-500">credits</span>
                          </div>
                        </div>
                        {/* A-F5: what buyers pay and the creator's share, in
                            money (`formatRecipeMoneyLine`). */}
                        <p id={recipeMoneyLineId} className="text-xs font-medium leading-5 text-emerald-200">
                          {recipeMoneyLine}
                        </p>

                        <div className="rounded-2xl border border-white/8 bg-white/[0.025] px-4 py-3 text-xs leading-5 text-zinc-400">
                          Before buying, people see your recipe preview and item titles — never what’s inside.
                          {Number.isFinite(parsedResourcePriceTokens)
                            && parsedResourcePriceTokens > 0
                            && parsedResourcePriceTokens < POST_RESOURCE_WEB_CASH_MIN_TOKENS ? (
                              <>
                                {' '}Under {POST_RESOURCE_WEB_CASH_MIN_TOKENS} credits, buyers unlock with
                                credits rather than a card checkout.
                              </>
                            ) : null}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs leading-5 text-zinc-400">
                        People can add a free recipe to their library with one click.
                      </p>
                    )}

                    {canOfferCreationResources ? (
                      <div role="group" aria-labelledby="from-this-creation-label" className="rounded-[24px] border border-white/8 bg-black/25 p-4 space-y-3">
                        <div id="from-this-creation-label" className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                          From this creation
                        </div>
                        <label className={`flex items-start gap-3 select-none ${creationPrompt ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                          <input
                            type="checkbox"
                            checked={isCreationPromptIncluded}
                            disabled={!creationPrompt}
                            onChange={(event) => toggleCreationPrompt(event.target.checked)}
                            className="mt-0.5 h-4 w-4 rounded border-white/10 bg-white/[0.03] text-emerald-400 focus:ring-0 focus:ring-offset-0 disabled:cursor-not-allowed"
                          />
                          <span>
                            <span className="block text-sm font-semibold text-white">Include exact prompt</span>
                            <span className="mt-0.5 block text-xs leading-5 text-zinc-400">
                              Add the original generation prompt to the recipe.
                            </span>
                          </span>
                        </label>
                        {canIncludeGenerationReferences ? (
                          <label className="flex cursor-pointer items-start gap-3 select-none">
                            <input
                              type="checkbox"
                              checked={includeGenerationReferences}
                              onChange={(event) => {
                                setIncludeGenerationReferences(event.target.checked);
                                resetFeedback();
                              }}
                              className="mt-0.5 h-4 w-4 rounded border-white/10 bg-white/[0.03] text-emerald-400 focus:ring-0 focus:ring-offset-0"
                            />
                            <span>
                              <span className="block text-sm font-semibold text-white">Include creation references</span>
                              <span className="mt-0.5 block text-xs leading-5 text-zinc-400">
                                Attach the saved input media as reusable references.
                              </span>
                            </span>
                          </label>
                        ) : null}
                      </div>
                    ) : null}

                    <ResourceCardsSection
                      cards={resourceCards}
                      mediaCount={mediaPreviewItems.length}
                      previewText={resourcePreviewText}
                      previewError={resourcePreviewError}
                      creationReferenceCount={includesCreationReferences ? prefilledGeneration?.referenceCount ?? 0 : 0}
                      includesRemix={recipeIncludesRemix}
                      buyerCount={recipeBuyerCount}
                      onAddCard={openResourceTypePicker}
                      onEditCard={editResourceCard}
                      onRemoveCard={removeResourceCard}
                      onPreviewTextChange={(nextPreviewText) => {
                        setResourcePreviewText(nextPreviewText);
                        resetFeedback();
                      }}
                    />
                  </div>
                ) : null}
              </div>

              {createdPost ? (
                <div
                  ref={savedPanelRef}
                  tabIndex={-1}
                  className="rounded-[28px] border border-emerald-500/20 bg-emerald-500/10 p-5 outline-none"
                >
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
                  {primaryPostPath || (createdPostHasResources && createdPost.resourceBundlePath) ? (
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
                  ) : null}
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

                {needsPublicIdentity ? (
                  <div className="mt-5">
                    <PublicIdentityFields
                      idPrefix="composer-identity"
                      value={identity}
                      errors={identityErrors}
                      disabled={isSubmitting}
                      accessToken={session?.access_token}
                      savedUsername={composerProfile?.username}
                      onChange={(next) => {
                        setIdentityEdits(next);
                        setIdentityErrors({});
                      }}
                    />
                  </div>
                ) : null}

                <div className="mt-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      type={isEditMode ? 'button' : 'submit'}
                      disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                      onClick={pressSecondarySubmit}
                      className="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-5 text-left transition hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
                        {secondaryPendingLabel ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {secondaryPendingLabel ?? secondarySubmit.label}
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-zinc-500">{secondarySubmit.detail}</p>
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting || isLoadingGeneration || Boolean(createdPost)}
                      onClick={() => submitWithVisibility(primarySubmit.target)}
                      className="ui-focus-ring rounded-2xl bg-[var(--ui-primary)] px-5 py-5 text-left transition hover:bg-[var(--ui-primary-strong)] disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      <div className="flex items-center gap-2 text-sm font-extrabold text-[var(--ui-primary-on)]">
                        {primaryPendingLabel ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {primaryPendingLabel ?? primarySubmit.label}
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-[#5c2c20]">{primarySubmit.detail}</p>
                    </button>
                  </div>
                </div>

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
