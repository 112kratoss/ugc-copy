import type {
  AppVersionResponse,
  CreatePostCommentBody,
  CreatePostResponse,
  CreatorFollowAttribution,
  CreatorProfileResponse,
  CreditHistoryResponse,
  GenerationListItem,
  GenerationListResponse,
  GenerationStartResponse,
  GenerationStatusResponse,
  SeedanceAssetResponse,
  GuestAccountMergeResponse,
  GuestAccountMergeTicketResponse,
  ImageGenerationRequest,
  MediaReadUrlRequest,
  MediaReadUrlResponse,
  MediaTemplateDetailResponse,
  MediaTemplateListResponse,
  MediaUploadIntentRequest,
  MediaUploadIntentResponse,
  MarketplaceResourceList,
  MarketplaceResourceDetailResponse,
  MobileNotificationPreferences,
  MobileNotificationsResponse,
  MobilePushTokenRegistration,
  MobileCommerceSyncResponse,
  MotionGenerationRequest,
  OnboardingEventRequest,
  OnboardingGoal,
  OnboardingStateResponse,
  OnboardingStatus,
  OwnerPostListItem,
  OwnerPostsResponse,
  ProfileResponse,
  ProfileMediaUploadIntentRequest,
  ProfileMediaUploadIntentResponse,
  PromptEnhancementRequest,
  PromptEnhancementResponse,
  ReferralClaimRequest,
  ReferralClaimResponse,
  ReferralLinkRequest,
  ReferralLinkResponse,
  ReferralOverviewResponse,
  ReferralVisitRequest,
  ReferralVisitResponse,
  WelcomeCreditResponse,
  PostResourceBundleInput,
  PostResourceFileFinalizeRequest,
  PostResourceFileFinalizeResponse,
  PostResourceFileSignRequest,
  PostResourceFileSignResponse,
  PostResourceBundleFreeUnlockResponse,
  PostResourceFileDisposition,
  PostResourceFileUrlBatchResponse,
  RemixSourceBundle,
  ShowcaseFeedEventRequest,
  ShowcaseFeedEventBatchResponse,
  ShowcaseFeedNewestResponse,
  HomeShelfResponse,
  ShowcaseFeedEventResponse,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
  PostCommentsResponse,
  CreatePostCommentResponse,
  DeletePostCommentResponse,
  SourceToolOption,
  TemplateRunInputFinalizeRequest,
  TemplateRunInputSignRequest,
  TemplateRunInputSignResponse,
  TemplateRunResponse,
  UploadFinalizeRequest,
  UploadFinalizeResponse,
  VideoGenerationRequest,
  ViewerUnlocksResponse,
  ViewerUnlockDetailResponse,
  GenerationShareSourceSurface,
  ProfileShareSourceSurface,
  PublicSearchResponse,
  PublicSearchType,
  ShareChannel,
  UndoFeedFeedbackRequest,
  UndoFeedFeedbackResponse,
} from './types';
import {
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  parseGenerationModelCatalog,
  type CatalogGenerationRequest,
  type GenerationModelCatalog,
  type GenerationModelQuote,
  type GenerationModelQuoteRequest,
} from './generation-model-catalog';
import {
  normalizeMediaTemplateDetailResponse,
  normalizeMediaTemplateListResponse,
  normalizeTemplateRunResponse,
  type TemplateReportReason,
} from './media-templates';
import type { MediaDiagnosticsReport } from './media-diagnostics';
import type { SeedanceAssetKind } from './model-catalog/seedance-assets';
import type { PlaybackMetricsReport } from './playback-metrics';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
    public requestId?: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * True for a request this client gave up on at its own deadline. It had been
 * sent, so the server may have acted on it; only the answer is missing. A
 * request that cannot get out at all (no connection) fails at once instead,
 * and one the deadline caught still waiting for its session token never left
 * the device (`sent: false`), so nothing can have happened on the server.
 */
export function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 0
    && typeof error.details === 'object'
    && error.details !== null
    && (error.details as { timedOut?: unknown }).timedOut === true
    && (error.details as { sent?: unknown }).sent !== false;
}

/**
 * Thrown when the server demands a forced app upgrade (HTTP 426) mid-session.
 * Callers can ignore it — the registered upgrade handler routes the user to
 * the update screen — or detect it via `instanceof` to skip error UI.
 */
export class UpgradeRequiredError extends ApiError {
  constructor(message: string, details?: unknown, requestId?: string, code?: string) {
    super(message, 426, details, requestId, code ?? 'MOBILE_UPDATE_REQUIRED');
    this.name = 'UpgradeRequiredError';
  }
}

export type UpgradeRequiredHandler = (error: UpgradeRequiredError) => void;

// The app shell (app/_layout.tsx) registers navigation to /update-required
// here so this lib never imports the router. Concurrent 426 responses collapse
// into a single handler invocation per notification window.
const UPGRADE_REQUIRED_RENOTIFY_INTERVAL_MS = 10_000;
let upgradeRequiredHandler: UpgradeRequiredHandler | null = null;
let upgradeRequiredNotifiedAt: number | null = null;

export function setUpgradeRequiredHandler(handler: UpgradeRequiredHandler | null) {
  upgradeRequiredHandler = handler;
  upgradeRequiredNotifiedAt = null;
}

function notifyUpgradeRequired(error: UpgradeRequiredError) {
  if (!upgradeRequiredHandler) return;
  const now = Date.now();
  if (
    upgradeRequiredNotifiedAt !== null
    && now - upgradeRequiredNotifiedAt < UPGRADE_REQUIRED_RENOTIFY_INTERVAL_MS
  ) {
    return;
  }
  upgradeRequiredNotifiedAt = now;
  try {
    upgradeRequiredHandler(error);
  } catch (handlerError) {
    console.warn('Upgrade-required handler failed', handlerError);
  }
}

export const SESSION_MERGED_CODE = 'SESSION_MERGED';

/**
 * Thrown when the caller's guest session has been linked to a registered
 * account (HTTP 409 `SESSION_MERGED`).
 *
 * The token is genuine but spent: its credits and the right to act for its data
 * moved to the account, so the server will refuse it forever. Refreshing cannot
 * help and retrying cannot succeed, which is why this is separated from every
 * other 409 — `ACCOUNT_DELETING` shares the status but not the remedy.
 */
export class SessionMergedError extends ApiError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super(message, 409, details, requestId, SESSION_MERGED_CODE);
    this.name = 'SessionMergedError';
  }
}

export type SessionMergedHandler = (error: SessionMergedError) => void;

// The app shell (app/_layout.tsx) registers the local session teardown here so
// this lib never imports the router or the auth provider. Every in-flight
// request fails at once when an identity is merged, so the same throttle the
// upgrade path uses keeps that burst to a single recovery.
const SESSION_MERGED_RENOTIFY_INTERVAL_MS = 10_000;
let sessionMergedHandler: SessionMergedHandler | null = null;
let sessionMergedNotifiedAt: number | null = null;

export function setSessionMergedHandler(handler: SessionMergedHandler | null) {
  sessionMergedHandler = handler;
  sessionMergedNotifiedAt = null;
}

function notifySessionMerged(error: SessionMergedError) {
  if (!sessionMergedHandler) return;
  const now = Date.now();
  if (
    sessionMergedNotifiedAt !== null
    && now - sessionMergedNotifiedAt < SESSION_MERGED_RENOTIFY_INTERVAL_MS
  ) {
    return;
  }
  sessionMergedNotifiedAt = now;
  try {
    sessionMergedHandler(error);
  } catch (handlerError) {
    console.warn('Session-merged handler failed', handlerError);
  }
}

export const ACCOUNT_DELETING_CODE = 'ACCOUNT_DELETING';

/**
 * Thrown when the account this device is signed in to is being permanently
 * deleted (HTTP 409 `ACCOUNT_DELETING`), whether the deletion was asked for on
 * this phone or on another device.
 *
 * Nothing can stop it: a `deleting` identity is never reactivated, and the
 * server finishes the job whatever the device does. Every account route refuses
 * the session from now on, so the registered handler ends it on this device.
 */
export class AccountDeletingError extends ApiError {
  constructor(message: string, details?: unknown, requestId?: string) {
    super(message, 409, details, requestId, ACCOUNT_DELETING_CODE);
    this.name = 'AccountDeletingError';
  }
}

export type AccountDeletingHandler = (error: AccountDeletingError) => void;

// Registered by the app shell (app/_layout.tsx), like the handlers above, and
// throttled the same way: a deleting account fails every in-flight request at
// once.
const ACCOUNT_DELETING_RENOTIFY_INTERVAL_MS = 10_000;
let accountDeletingHandler: AccountDeletingHandler | null = null;
let accountDeletingNotifiedAt: number | null = null;

export function setAccountDeletingHandler(handler: AccountDeletingHandler | null) {
  accountDeletingHandler = handler;
  accountDeletingNotifiedAt = null;
}

function notifyAccountDeleting(error: AccountDeletingError) {
  if (!accountDeletingHandler) return;
  const now = Date.now();
  if (
    accountDeletingNotifiedAt !== null
    && now - accountDeletingNotifiedAt < ACCOUNT_DELETING_RENOTIFY_INTERVAL_MS
  ) {
    return;
  }
  accountDeletingNotifiedAt = now;
  try {
    accountDeletingHandler(error);
  } catch (handlerError) {
    console.warn('Account-deleting handler failed', handlerError);
  }
}

export const UNAUTHORIZED_CODE = 'UNAUTHORIZED';

/**
 * Thrown when the server refused the session token this device sent (HTTP 401).
 *
 * The usual cause is a session that ended somewhere else: signing out on
 * another device used to end every session on the account. The device cannot
 * see that by itself. An access token is self-contained and still carries a
 * future expiry, so without a recovery it is sent, and refused, on every
 * request until it runs out, and every screen shows an error whose Retry cannot
 * succeed. The registered handler asks the auth provider to check the session
 * with Supabase and recover.
 */
export class SessionRejectedError extends ApiError {
  constructor(message: string, details?: unknown, requestId?: string, code?: string) {
    super(message, 401, details, requestId, code ?? UNAUTHORIZED_CODE);
    this.name = 'SessionRejectedError';
  }
}

export type SessionRejectedHandler = (error: SessionRejectedError) => void;

// Registered by the app shell (app/_layout.tsx), like the two handlers above.
// A refused session fails every in-flight request at once, so the same throttle
// keeps that burst to one recovery, and a device still refused after the window
// tries again.
const SESSION_REJECTED_RENOTIFY_INTERVAL_MS = 10_000;
let sessionRejectedHandler: SessionRejectedHandler | null = null;
let sessionRejectedNotifiedAt: number | null = null;

export function setSessionRejectedHandler(handler: SessionRejectedHandler | null) {
  sessionRejectedHandler = handler;
  sessionRejectedNotifiedAt = null;
}

function notifySessionRejected(error: SessionRejectedError) {
  if (!sessionRejectedHandler) return;
  const now = Date.now();
  if (
    sessionRejectedNotifiedAt !== null
    && now - sessionRejectedNotifiedAt < SESSION_REJECTED_RENOTIFY_INTERVAL_MS
  ) {
    return;
  }
  sessionRejectedNotifiedAt = now;
  try {
    sessionRejectedHandler(error);
  } catch (handlerError) {
    console.warn('Session-rejected handler failed', handlerError);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  getInstallationId?: () => Promise<string | null>;
  clientInfo?: MobileClientInfo;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface MobileClientInfo {
  appVersion: string;
  apiVersion: number;
  catalogSchemaVersion: number;
}

export type GenerationModelCatalogFetchResult = {
  catalog: GenerationModelCatalog | null;
  etag: string | null;
  notModified: boolean;
};

type QueryValue = string | number | boolean | null | undefined;
type RequestOptions = {
  auth?: boolean;
  cacheTtlMs?: number;
  /** This request's own deadline, in place of the client's `requestTimeoutMs`. */
  timeoutMs?: number;
};

/** What `GET /api/posts?scope=owner` takes: offset pages by default, cursor pages on request. */
export type OwnerPostsQuery = {
  visibility?: 'all' | 'public' | 'unlisted' | 'private' | 'archived';
  includeArchived?: boolean;
  /** Only posts with a recipe, paged by the server: the listings on Your Sales. */
  listingsOnly?: boolean;
  /** The seller totals (`summary`), asked for with the first page. */
  includeSummary?: boolean;
  limit?: number;
  offset?: number;
  pagination?: 'cursor';
  cursor?: string;
};

export interface SaveShowcasePostOptions {
  shouldSave: boolean;
  sourceSurface?: string;
  /**
   * Lets the creator's alert name whoever saved: the person was told before
   * this tap. Only ever set from `creatorSeesSaverFields` (lib/saver-notice.ts):
   * the server takes it as word that they were told.
   */
  creatorSeesSaver?: true;
  /**
   * The person is being told now, at this tap or while the notice is up: the
   * creator hears nothing of this save. Only ever set from
   * `creatorSeesSaverFields`.
   */
  saverNotYetTold?: true;
}

/** Whether the account has been told that creators can see who saved its posts. */
export interface SaverNoticeResponse {
  seen: boolean;
}

export interface ShareShowcasePostOptions {
  sourceSurface: GenerationShareSourceSurface;
  channel?: ShareChannel;
}

export interface ShareCreatorProfileOptions {
  sourceSurface: ProfileShareSourceSurface;
  channel?: ShareChannel;
}

export interface GenerationListOptions {
  cursor?: string | null;
  id?: string;
  limit?: number;
  /**
   * `summary` (the default) signs each run's media; `status` answers only what a count
   * needs (id, status, times, model), which the in-flight ring polls every 10 s.
   */
  detail?: 'summary' | 'status';
}

export interface SaveShowcasePostResponse {
  success: boolean;
  isSaved: boolean;
  saveCount: number;
  changed: boolean;
  message?: string;
}

export type UserReportReason = 'spam' | 'harassment' | 'impersonation' | 'unsafe_content' | 'other';
export type GenerationReportReason = 'offensive_ai_output' | 'unsafe_content' | 'other';
export type CommentReportReason = 'spam' | 'harassment' | 'unsafe_content' | 'other';
/** Someone the signed-in viewer has blocked, named the way a post's creator is named. */
export type BlockedUser = {
  id: string;
  username: string | null;
  name: string;
  avatar: string | null;
  blockedAt: string;
};

/**
 * `DELETE /api/account`. 202 with `deletionScheduled` once the account is
 * locked and signed out everywhere, while the server sweeps the rest behind the
 * answer; 200 with `deleted` only for a deletion that had already completed.
 */
export type AccountDeletionResponse = {
  success: boolean;
  deleted: boolean;
  deletionScheduled?: boolean;
  alreadyDeleted?: boolean;
  cleanupPending?: boolean;
};

/**
 * A purchase the restore left alone instead of failing the whole restore:
 * `transaction_conflict` means the store transaction is already on file for
 * another account, product or store.
 */
export type SkippedMobileCreditPurchase = {
  transactionId: string;
  productId: string;
  reason: 'transaction_conflict';
};

/**
 * `POST /api/mobile/commerce/restore`. The counts, the balance and `skipped`
 * are absent from a server older than the restore that skips a conflict.
 */
export type MobileCommerceRestoreResponse = {
  success: boolean;
  /** The balance after the restore. */
  credits?: number | null;
  /** Credit purchases this restore settled for the first time. */
  restoredCreditPurchases?: number;
  alreadyProcessedCreditPurchases?: number;
  skipped?: SkippedMobileCreditPurchase[];
  entitlements: MobileCommerceSyncResponse[];
};

export type CreatorPayoutRequestSummary = {
  id: string;
  amountTokenSubunits: number;
  amountUsd: string;
  status: 'requested' | 'paid' | 'rejected';
  payoutMethod: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  externalReference: string | null;
};

/**
 * `GET /api/creator/payouts`: the seller's wallet. Amounts are token subunits;
 * the dollar strings are formatted by the server. A request already filed is
 * held apart from `available` and is still paid if the account is deleted.
 */
export type CreatorPayoutStateResponse = {
  success: true;
  availableTokenSubunits: number;
  heldTokenSubunits: number;
  lifetimeEarnedTokenSubunits: number;
  lifetimePaidOutTokenSubunits: number;
  availableUsd: string;
  minimumTokenSubunits: number;
  minimumUsd: string;
  /** False until the balance reaches the minimum and no request is open. */
  canRequest: boolean;
  pendingRequest: CreatorPayoutRequestSummary | null;
  history: CreatorPayoutRequestSummary[];
};

export type ModerationReportSourceSurface =
  | 'showcase'
  | 'showcase-reel'
  | 'creator-profile'
  | 'generation-viewer'
  | 'comments';

const CONTENT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 30_000;
/**
 * A start answers only after it has measured each priced reference (up to 20 s each),
 * created the provider task (up to 30 s) and copied every input across, so a video with
 * large references ran past the 30 s every other request gets and read as unconfirmed
 * although it had started.
 */
export const GENERATION_START_TIMEOUT_MS = 120_000;
const GENERATION_START_REQUEST_OPTIONS: RequestOptions = { timeoutMs: GENERATION_START_TIMEOUT_MS };
/**
 * A deletion is answered once the account is locked and every session revoked.
 * At the usual 30 s a slow answer read as a failure, and the person was told
 * the account survived while it was being erased.
 */
export const ACCOUNT_DELETION_TIMEOUT_MS = 120_000;
/**
 * Creating a post may take the create route's whole budget (`maxDuration`,
 * 300 s, in src/app/api/posts/route.ts; the single-file path still transcodes
 * before it answers). Given up on at the usual 30 s, a post still being created
 * read as a failure. This deadline outlasts that budget, so the route's own
 * answer, a 504 from the platform included, arrives first.
 */
export const POST_CREATE_TIMEOUT_MS = 310_000;
const POST_CREATE_REQUEST_OPTIONS: RequestOptions = { timeoutMs: POST_CREATE_TIMEOUT_MS };
/**
 * The enhancer may wait on Kie for 45 s, asking again when an answer is slow
 * (src/lib/prompt-enhancer.ts), but only for a request that says it waits that
 * long: at the usual 30 s a slow answer was given up on here, then charged on
 * the server and never shown. The wait is stated in `PROMPT_ENHANCE_WAIT_HEADER`.
 */
export const PROMPT_ENHANCE_TIMEOUT_MS = 70_000;
const PROMPT_ENHANCE_WAIT_HEADER = 'x-magicbooklet-wait-ms';
const PROMPT_ENHANCE_REQUEST_OPTIONS: RequestOptions = { timeoutMs: PROMPT_ENHANCE_TIMEOUT_MS };
const REQUEST_ID_HEADER = 'x-request-id';
const FEED_INSTALLATION_ID_HEADER = 'x-magicbooklet-installation-id';

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, '');
}

function isLocalApiRoot(root: string) {
  try {
    const hostname = new URL(root).hostname;
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '10.0.2.2'
      || hostname.startsWith('192.168.')
      || hostname.endsWith('.local');
  } catch {
    return false;
  }
}

function networkFailureMessage(root: string) {
  if (isLocalApiRoot(root)) {
    return `Could not reach local API at ${root}. Start the web app and check EXPO_PUBLIC_API_BASE_URL.`;
  }

  return 'Network request failed. Please check your connection and try again.';
}

const GAVE_UP = Symbol('gave up');

/**
 * What `work` settles with, or GAVE_UP if `signal` aborts first. Nothing here
 * can cancel `work`: it runs on, and a late result or failure is dropped.
 */
function unlessGivenUp<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof GAVE_UP> {
  return new Promise((resolve, reject) => {
    const giveUp = () => resolve(GAVE_UP);
    work.then(
      (value) => {
        signal.removeEventListener('abort', giveUp);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', giveUp);
        reject(error);
      },
    );
    if (signal.aborted) {
      giveUp();
    } else {
      signal.addEventListener('abort', giveUp, { once: true });
    }
  });
}

function absolutizeMediaUrl(root: string, url: string | null | undefined) {
  if (!url) return url ?? null;
  try {
    return new URL(url, `${root}/`).toString();
  } catch {
    return url;
  }
}

function normalizeGenerationMediaUrls(root: string, item: GenerationListItem): GenerationListItem {
  const previewUrl = absolutizeMediaUrl(root, item.previewUrl ?? item.preview_url);
  const isTemplateResult = item.origin === 'template';

  return {
    ...item,
    // Template consumers receive the result and public attribution, never the
    // underlying model, prompt, or source references from the private recipe.
    ...(isTemplateResult ? {
      model: 'Magicbooklet template',
      prompt: null,
      input_media: [],
    } : { input_media: item.input_media?.map((media) => ({ ...media, url: absolutizeMediaUrl(root, media.url) })) }),
    output_url: absolutizeMediaUrl(root, item.output_url),
    output_urls: item.output_urls?.map((url) => absolutizeMediaUrl(root, url)).filter((url): url is string => Boolean(url)),
    preview_url: previewUrl,
    previewUrl,
    media: item.media ? {
      ...item.media,
      url: absolutizeMediaUrl(root, item.media.url) ?? item.media.url,
      previewUrl: absolutizeMediaUrl(root, item.media.previewUrl),
      // Absent and null both mean "open the original"; only a present address moves.
      ...(item.media.displayUrl !== undefined ? {
        displayUrl: absolutizeMediaUrl(root, item.media.displayUrl),
      } : {}),
      ...(item.media.renditionUrl !== undefined ? {
        renditionUrl: absolutizeMediaUrl(root, item.media.renditionUrl),
      } : {}),
      ...(item.media.teaserUrl !== undefined ? {
        teaserUrl: absolutizeMediaUrl(root, item.media.teaserUrl),
      } : {}),
      // Absent is the old-server fallback; explicit null means poster-only.
      ...(item.media.feedStreamUrl !== undefined ? {
        feedStreamUrl: absolutizeMediaUrl(root, item.media.feedStreamUrl),
      } : {}),
    } : item.media,
    input_media: isTemplateResult
      ? []
      : item.input_media?.map((media) => ({
        ...media,
        url: absolutizeMediaUrl(root, media.url),
      })),
  };
}

type MediaTemplateReadOptions = {
  /** Read past the five-minute copy kept for public reads, and keep the new answer in its place. */
  fresh?: boolean;
};

function normalizeTemplateListMediaUrls(root: string, response: MediaTemplateListResponse): MediaTemplateListResponse {
  return {
    ...response,
    templates: response.templates.map((template) => ({
      ...template,
      thumbnailUrl: absolutizeMediaUrl(root, template.thumbnailUrl),
      videoUrl: absolutizeMediaUrl(root, template.videoUrl),
      creator: template.creator ? {
        ...template.creator,
        avatarUrl: absolutizeMediaUrl(root, template.creator.avatarUrl),
      } : null,
    })),
  };
}

function normalizeTemplateRunMediaUrls(root: string, response: TemplateRunResponse): TemplateRunResponse {
  return {
    ...response,
    run: {
      ...response.run,
      templateCreator: response.run.templateCreator ? {
        ...response.run.templateCreator,
        avatarUrl: absolutizeMediaUrl(root, response.run.templateCreator.avatarUrl),
      } : null,
      inputs: response.run.inputs.map((input) => ({
        ...input,
        previewUrl: absolutizeMediaUrl(root, input.previewUrl),
      })),
      steps: response.run.steps.map((step) => ({
        ...step,
        outputUrl: absolutizeMediaUrl(root, step.outputUrl),
        ...(step.renditionUrl !== undefined ? { renditionUrl: absolutizeMediaUrl(root, step.renditionUrl) } : {}),
        ...(step.previewUrl !== undefined ? { previewUrl: absolutizeMediaUrl(root, step.previewUrl) } : {}),
      })),
      result: response.run.result ? {
        ...response.run.result,
        url: absolutizeMediaUrl(root, response.run.result.url) ?? response.run.result.url,
        ...(response.run.result.renditionUrl !== undefined ? { renditionUrl: absolutizeMediaUrl(root, response.run.result.renditionUrl) } : {}),
        ...(response.run.result.previewUrl !== undefined ? { previewUrl: absolutizeMediaUrl(root, response.run.result.previewUrl) } : {}),
      } : null,
    },
  };
}

function buildQuery(params?: Record<string, QueryValue>) {
  if (!params) return '';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

function createGenerationIdempotencyKey(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) {
    return `${prefix}:${randomUUID()}`;
  }

  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function createMobileRequestId(): string {
  return createGenerationIdempotencyKey('mobile');
}

function generationStartInit(body: unknown, prefix: string, idempotencyKey?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Idempotency-Key': idempotencyKey ?? createGenerationIdempotencyKey(prefix),
    },
    body: JSON.stringify(body),
  };
}

function isNotFoundError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404;
}

/** The most paths the file-url route signs in one `{ storagePaths }` call. */
export const POST_RESOURCE_FILE_URL_BATCH_LIMIT = 25;

export interface PostResourceFileUrlOptions {
  disposition?: PostResourceFileDisposition;
}

type FileUrlWaiter = { resolve: (url: string) => void; reject: (error: unknown) => void };

/**
 * Signs a bundle's files in as few calls as the server allows.
 *
 * Each reference preview signs its own file as it mounts, and on the server
 * every signing loaded the whole entitlement again and counted against the
 * viewer's signing limit: ten references, ten loads. The calls one render makes
 * arrive in the same tick, so they wait one microtask and leave together as one
 * `{ storagePaths }` request per post. A path asked for on its own, an explicit
 * Open, still takes the single form.
 *
 * A server without the batch form answers it 400 ("Missing resource file
 * path."), so a 400, or an answer with no `files`, falls back to the single
 * form for each path. A path missing from the answer was not signed (it is not
 * on this unlock, or storage refused it; the route leaves it out rather than
 * failing the paths beside it), so it is refused here without asking again:
 * an explicit Open asks for it on its own. Any other refusal (no access,
 * nothing on the unlock, the signing limit) is the answer for every path in
 * the batch.
 */
export function createPostResourceFileUrlResolver({
  signMany,
  signOne,
}: {
  signMany: (postId: string, storagePaths: string[], options: PostResourceFileUrlOptions) => Promise<PostResourceFileUrlBatchResponse>;
  signOne: (postId: string, storagePath: string, options: PostResourceFileUrlOptions) => Promise<string>;
}) {
  const queues = new Map<string, Map<string, FileUrlWaiter[]>>();

  function settle(waiters: Map<string, FileUrlWaiter[]>, storagePath: string, outcome: Promise<string>) {
    const pending = waiters.get(storagePath) ?? [];
    outcome.then(
      (url) => pending.forEach((waiter) => waiter.resolve(url)),
      (error: unknown) => pending.forEach((waiter) => waiter.reject(error)),
    );
  }

  async function signChunk(
    postId: string,
    chunk: string[],
    options: PostResourceFileUrlOptions,
    waiters: Map<string, FileUrlWaiter[]>,
  ) {
    let answer: Partial<PostResourceFileUrlBatchResponse> | null = null;
    try {
      answer = await signMany(postId, chunk, options);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 400) {
        chunk.forEach((storagePath) => settle(waiters, storagePath, Promise.reject(error)));
        return;
      }
    }

    if (!answer || !Array.isArray(answer.files)) {
      chunk.forEach((storagePath) => settle(waiters, storagePath, signOne(postId, storagePath, options)));
      return;
    }

    const urls = new Map(answer.files
      .filter((file) => typeof file?.storagePath === 'string' && typeof file.url === 'string' && file.url.length > 0)
      .map((file) => [file.storagePath, file.url] as const));
    for (const storagePath of chunk) {
      const url = urls.get(storagePath);
      settle(waiters, storagePath, url
        ? Promise.resolve(url)
        : Promise.reject(new ApiError('Resource file not found on this unlock.', 404)));
    }
  }

  function flush(postId: string, options: PostResourceFileUrlOptions, waiters: Map<string, FileUrlWaiter[]>) {
    const paths = [...waiters.keys()];
    if (paths.length === 1) {
      settle(waiters, paths[0], signOne(postId, paths[0], options));
      return;
    }
    for (let start = 0; start < paths.length; start += POST_RESOURCE_FILE_URL_BATCH_LIMIT) {
      const chunk = paths.slice(start, start + POST_RESOURCE_FILE_URL_BATCH_LIMIT);
      // Nothing may leave a preview waiting forever; a settled waiter ignores this.
      void signChunk(postId, chunk, options, waiters).catch((error: unknown) => {
        chunk.forEach((storagePath) => settle(waiters, storagePath, Promise.reject(error)));
      });
    }
  }

  return (postId: string, storagePath: string, options: PostResourceFileUrlOptions = {}) => (
    new Promise<string>((resolve, reject) => {
      const key = `${postId}\n${options.disposition ?? ''}`;
      let waiters = queues.get(key);
      if (!waiters) {
        const batch = new Map<string, FileUrlWaiter[]>();
        waiters = batch;
        queues.set(key, batch);
        void Promise.resolve().then(() => {
          queues.delete(key);
          flush(postId, options, batch);
        });
      }
      waiters.set(storagePath, [...(waiters.get(storagePath) ?? []), { resolve, reject }]);
    })
  );
}

async function parseResponse(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function throwHttpApiError(
  status: number,
  body: unknown,
  requestId: string | undefined,
  sentSessionToken: boolean,
): never {
  const message =
    typeof body === 'object' && body && 'error' in body
      ? String((body as { error?: unknown }).error)
      : `Request failed with status ${status}`;
  const code = typeof body === 'object' && body && 'code' in body && typeof body.code === 'string'
    ? body.code
    : undefined;
  if (status === 426) {
    const upgradeError = new UpgradeRequiredError(message, body, requestId, code);
    notifyUpgradeRequired(upgradeError);
    throw upgradeError;
  }
  // Gated on the code, not the status: SESSION_MERGED and ACCOUNT_DELETING are
  // both 409s, and each has a remedy of its own.
  if (status === 409 && code === SESSION_MERGED_CODE) {
    const mergedError = new SessionMergedError(message, body, requestId);
    notifySessionMerged(mergedError);
    throw mergedError;
  }
  // Only this device's own session can belong to the account being deleted. A
  // token the caller supplied itself (the feed-event queue draining a previous
  // identity) says nothing about who is signed in now.
  if (status === 409 && code === ACCOUNT_DELETING_CODE) {
    const deletingError = new AccountDeletingError(message, body, requestId);
    if (sentSessionToken) notifyAccountDeleting(deletingError);
    throw deletingError;
  }
  // Only a request that presented this device's session token can have had it
  // refused. A signed-out request to an account-only route is a 401 too, and a
  // token the caller supplied itself (the feed-event queue draining a previous
  // identity) says nothing about the current session. A 401 naming any other
  // code has a different cause.
  if (status === 401 && sentSessionToken && (code === undefined || code === UNAUTHORIZED_CODE)) {
    const rejectedError = new SessionRejectedError(message, body, requestId, code);
    notifySessionRejected(rejectedError);
    throw rejectedError;
  }
  throw new ApiError(message, status, body, requestId, code);
}

export function createApiClient({
  baseUrl,
  getAccessToken,
  getInstallationId,
  clientInfo,
  fetcher = fetch,
  requestTimeoutMs = DEFAULT_API_REQUEST_TIMEOUT_MS,
}: ApiClientOptions) {
  const root = normalizeBaseUrl(baseUrl);
  const requestedCatalogSchemaVersion = clientInfo?.catalogSchemaVersion;
  const catalogSchemaVersion = requestedCatalogSchemaVersion === 2
    || requestedCatalogSchemaVersion === GENERATION_MODEL_CATALOG_SCHEMA_VERSION
    ? requestedCatalogSchemaVersion
    : 1;
  const responseCache = new Map<string, {
    expiresAt: number;
    promise?: Promise<unknown>;
    value?: unknown;
  }>();

  async function readCatalogTransport(path: string, etag?: string) {
    const headers = new Headers({ [REQUEST_ID_HEADER]: createMobileRequestId(), 'x-magicbooklet-client': 'mobile' });
    if (clientInfo) {
      headers.set('x-magicbooklet-app-version', clientInfo.appVersion);
      headers.set('x-magicbooklet-api-version', String(clientInfo.apiVersion));
      headers.set('x-magicbooklet-catalog-schema-version', String(clientInfo.catalogSchemaVersion));
    }
    if (etag) headers.set('If-None-Match', etag);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetcher(`${root}/api/model-catalog/v1${path}`, { headers, signal: controller.signal });
      if (response.status === 304) return { body: null, etag: response.headers.get('etag') ?? etag ?? null, notModified: true };
      const body = await parseResponse(response);
      if (!response.ok) throwHttpApiError(response.status, body, response.headers.get(REQUEST_ID_HEADER) ?? undefined, false);
      return { body, etag: response.headers.get('etag'), notModified: false };
    } finally { clearTimeout(timeout); }
  }

  async function request<T>(
    path: string,
    init: RequestInit = {},
    options: RequestOptions = { auth: true }
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const cacheKey = `${root}${path}`;
    const shouldUseCache = options.auth === false && method === 'GET' && !init.body && Boolean(options.cacheTtlMs);

    if (shouldUseCache) {
      const cached = responseCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.promise) {
          return cached.promise as Promise<T>;
        }

        return cached.value as T;
      }
    }

    const load = async () => {
      const headers = new Headers(init.headers);
      const isFormDataBody = typeof FormData !== 'undefined' && init.body instanceof FormData;
      if (!headers.has('Content-Type') && init.body && !isFormDataBody) {
        headers.set('Content-Type', 'application/json');
      }
      if (!headers.has(REQUEST_ID_HEADER)) {
        headers.set(REQUEST_ID_HEADER, createMobileRequestId());
      }
      if (path.startsWith('/api/showcase/feed') && getInstallationId && !headers.has(FEED_INSTALLATION_ID_HEADER)) {
        const installationId = await getInstallationId().catch(() => null);
        if (installationId) headers.set(FEED_INSTALLATION_ID_HEADER, installationId);
      }
      if (clientInfo) {
        if (!headers.has('x-magicbooklet-client')) headers.set('x-magicbooklet-client', 'mobile');
        if (!headers.has('x-magicbooklet-app-version')) headers.set('x-magicbooklet-app-version', clientInfo.appVersion);
        if (!headers.has('x-magicbooklet-api-version')) headers.set('x-magicbooklet-api-version', String(clientInfo.apiVersion));
        if (!headers.has('x-magicbooklet-catalog-schema-version')) {
          headers.set('x-magicbooklet-catalog-schema-version', String(clientInfo.catalogSchemaVersion));
        }
      }
      const requestId = headers.get(REQUEST_ID_HEADER) ?? undefined;
      const url = `${root}${path}`;
      let response: Response;
      let body: unknown;
      // Armed before the wait for a session token, so the deadline and the
      // caller's cancellation cover that wait too. It can be a token refresh
      // stalled on the network and holding auth-js's lock, which Android's
      // HTTP client never times out; without this every request queued
      // behind it would spin for good.
      const requestController = new AbortController();
      const upstreamSignal = init.signal;
      const abortFromUpstream = () => requestController.abort(upstreamSignal?.reason);
      if (upstreamSignal?.aborted) {
        abortFromUpstream();
      } else {
        upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
      }
      const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        requestController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      let sentSessionToken = false;
      try {
        if (options.auth !== false) {
          // Given up on, never cancelled: only a sign-out may cut a refresh
          // short (lib/supabase-fetch.ts). The refresh keeps the lock and runs
          // on, and a later request gets the token it ends with.
          const token = await unlessGivenUp(getAccessToken(), requestController.signal);
          if (token && token !== GAVE_UP) {
            headers.set('Authorization', `Bearer ${token}`);
            sentSessionToken = true;
          }
        }
        if (requestController.signal.aborted) {
          throw new ApiError(networkFailureMessage(root), 0, {
            url,
            cause: timedOut
              ? `Request timed out after ${timeoutMs}ms before it was sent`
              : 'Request canceled before it was sent',
            ...(timedOut ? { timedOut: true } : {}),
            // Read by isRequestTimeoutError: nothing left the device.
            sent: false,
          }, requestId);
        }

        try {
          response = await fetcher(url, {
            ...init,
            headers,
            signal: requestController.signal,
          });
          // fetch resolves at headers. Keep timeout and caller cancellation
          // active until the body is consumed, including signed-link responses.
          body = await parseResponse(response);
        } catch (error) {
          throw new ApiError(networkFailureMessage(root), 0, {
            url,
            cause: error instanceof Error ? error.message : String(error),
            // Read by isRequestTimeoutError: the request had left, so the server
            // may have acted on it.
            ...(timedOut ? { timedOut: true } : {}),
          }, requestId);
        }
      } finally {
        clearTimeout(timeoutId);
        upstreamSignal?.removeEventListener('abort', abortFromUpstream);
      }
      const responseRequestId = response.headers.get(REQUEST_ID_HEADER) ?? requestId;

      if (!response.ok) {
        throwHttpApiError(response.status, body, responseRequestId, sentSessionToken);
      }

      return body as T;
    };

    if (!shouldUseCache) {
      return load();
    }

    const promise = load()
      .then((value) => {
        responseCache.set(cacheKey, {
          expiresAt: Date.now() + (options.cacheTtlMs ?? 0),
          value,
        });
        return value;
      })
      .catch((error) => {
        responseCache.delete(cacheKey);
        throw error;
      });

    responseCache.set(cacheKey, {
      expiresAt: Date.now() + (options.cacheTtlMs ?? 0),
      promise,
    });

    return promise;
  }

  // `disposition` goes only when asked for, so a plain call keeps the body
  // every server build has always taken.
  const fileUrlBody = (paths: { storagePath: string } | { storagePaths: string[] }, options: PostResourceFileUrlOptions) => (
    JSON.stringify({ ...paths, ...(options.disposition ? { disposition: options.disposition } : {}) })
  );
  const getPostResourceFileUrl = (postId: string, storagePath: string, options: PostResourceFileUrlOptions = {}) =>
    request<{ success: boolean; signedUrl: string }>(`/api/posts/${postId}/resource-bundle/file-url`, {
      method: 'POST',
      body: fileUrlBody({ storagePath }, options),
    });
  const getPostResourceFileUrls = (postId: string, storagePaths: string[], options: PostResourceFileUrlOptions = {}) =>
    request<PostResourceFileUrlBatchResponse>(`/api/posts/${postId}/resource-bundle/file-url`, {
      method: 'POST',
      body: fileUrlBody({ storagePaths }, options),
    });
  const resolvePostResourceFileUrl = createPostResourceFileUrlResolver({
    signMany: getPostResourceFileUrls,
    signOne: async (postId, storagePath, options) => (await getPostResourceFileUrl(postId, storagePath, options)).signedUrl,
  });
  // The buyer-library route takes the same two forms and answers them the same
  // way, by purchase instead of by post.
  const viewerUnlockFileUrlPath = (unlockId: string) => `/api/me/unlocks/${encodeURIComponent(unlockId)}/file-url`;
  const getViewerUnlockFileUrl = (unlockId: string, storagePath: string, options: PostResourceFileUrlOptions = {}) =>
    request<{ success: boolean; signedUrl: string }>(viewerUnlockFileUrlPath(unlockId), {
      method: 'POST',
      body: fileUrlBody({ storagePath }, options),
    });
  const getViewerUnlockFileUrls = (unlockId: string, storagePaths: string[], options: PostResourceFileUrlOptions = {}) =>
    request<PostResourceFileUrlBatchResponse>(viewerUnlockFileUrlPath(unlockId), {
      method: 'POST',
      body: fileUrlBody({ storagePaths }, options),
    });
  // The resolver gathers paths under the id it is handed: here the purchase's.
  const resolveViewerUnlockFileUrl = createPostResourceFileUrlResolver({
    signMany: getViewerUnlockFileUrls,
    signOne: async (unlockId, storagePath, options) => (await getViewerUnlockFileUrl(unlockId, storagePath, options)).signedUrl,
  });

  return {
    request,
    getAppVersion: () => request<AppVersionResponse>('/api/app-version', {}, { auth: false }),
    getProfile: () => request<ProfileResponse>('/api/profile'),
    validateProfile: (body: Partial<ProfileResponse>) =>
      request<{ ok: true }>('/api/profile/validate', { method: 'POST', body: JSON.stringify(body) }),
    updateProfile: (body: Partial<ProfileResponse>) =>
      request<ProfileResponse>('/api/profile', { method: 'PATCH', body: JSON.stringify(body) }),
    getOnboardingState: () => request<OnboardingStateResponse>('/api/onboarding/state'),
    updateOnboardingState: (body: { status?: OnboardingStatus; goal?: OnboardingGoal | null }) =>
      request<OnboardingStateResponse>('/api/onboarding/state', { method: 'PATCH', body: JSON.stringify(body) }),
    getWelcomeCredits: () => request<WelcomeCreditResponse>('/api/credits/welcome'),
    claimWelcomeCredits: () => request<WelcomeCreditResponse>('/api/credits/welcome/claim', {
      method: 'POST',
      body: JSON.stringify({ sourceSurface: 'mobile' }),
    }),
    /**
     * What added credits to this identity and what took them, newest first: a
     * guest's own, or an account's with every guest linked to it (contract C4).
     * `cursor` is the previous page's `nextCursor`; the server takes a `limit`
     * of 1 to 50 (30 when left out) and answers a cursor it did not write 400.
     */
    getCreditHistory: (params: { cursor?: string | null; limit?: number } = {}) =>
      request<CreditHistoryResponse>(`/api/credits/history${buildQuery({
        cursor: params.cursor,
        limit: params.limit,
      })}`),
    recordOnboardingEvent: async (body: OnboardingEventRequest) => {
      const installationId = await getInstallationId?.().catch(() => null);
      if (!installationId) return { success: false as const };
      return request<{ success: true }>('/api/onboarding/events', {
        method: 'POST',
        body: JSON.stringify({ ...body, installationId }),
      });
    },
    /**
     * A sampled media-failure report from `lib/media-diagnostics`. Sent without
     * credentials: it carries no identity, and has to get through while the
     * session itself may be what is failing.
     */
    reportMediaDiagnostics: (report: MediaDiagnosticsReport) =>
      request<unknown>('/api/mobile/media-diagnostics', {
        method: 'POST',
        body: JSON.stringify(report),
      }, { auth: false }),
    /**
     * A session's aggregated video start-up and stall numbers from
     * `lib/playback-metrics`. Anonymous, like the diagnostics above.
     */
    reportPlaybackMetrics: (report: PlaybackMetricsReport) =>
      request<unknown>('/api/mobile/playback-metrics', {
        method: 'POST',
        body: JSON.stringify(report),
      }, { auth: false }),
    deleteAccount: (
      confirmation: 'DELETE',
      options: { appleAuthorizationCode?: string } = {},
    ) =>
      request<AccountDeletionResponse>('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ confirmation, ...options }),
      }, { timeoutMs: ACCOUNT_DELETION_TIMEOUT_MS }),
    /** The seller's unpaid balance, which deleting the account forfeits. */
    getCreatorPayoutState: () => request<CreatorPayoutStateResponse>('/api/creator/payouts'),
    /**
     * Called while still a guest, immediately before the sign-in that will
     * replace this session. Returns a one-time ticket to persist securely.
     */
    prepareGuestAccountMerge: () =>
      request<GuestAccountMergeTicketResponse>('/api/account/merge/prepare', {
        method: 'POST',
      }),
    /**
     * Called as the newly registered user, with the ticket minted above.
     * Retryable: the ticket stays valid for 30 days and is only spent on a
     * settled outcome.
     */
    mergeGuestAccount: (ticket: string) =>
      request<GuestAccountMergeResponse>('/api/account/merge', {
        method: 'POST',
        body: JSON.stringify({ ticket }),
      }),
    getReferralOverview: () =>
      request<ReferralOverviewResponse>('/api/referrals/me'),
    createReferralLink: (body: ReferralLinkRequest = {}) =>
      request<ReferralLinkResponse>('/api/referrals/link', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    recordReferralVisit: async (body: Omit<ReferralVisitRequest, 'installationId'>) => {
      const installationId = await getInstallationId?.().catch(() => null);
      return request<ReferralVisitResponse>('/api/referrals/visit', {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          ...(installationId ? { installationId } : {}),
        }),
      }, { auth: false });
    },
    claimReferral: (body: ReferralClaimRequest) =>
      request<ReferralClaimResponse>('/api/referrals/claim', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listGenerations: async (includeArchived = true, options: GenerationListOptions = {}) => {
      const response = await request<GenerationListResponse>(`/api/generations${buildQuery({
        detail: options.detail ?? 'summary',
        includeArchived,
        id: options.id,
        limit: options.limit,
        cursor: options.cursor,
      })}`);
      return {
        ...response,
        generations: response.generations.map((item) => normalizeGenerationMediaUrls(root, item)),
      };
    },
    getGenerationDetails: async (generationId: string): Promise<GenerationListItem | null> => {
      const id = generationId.trim();
      if (!id) return null;
      // Omit detail=summary only for this owner-scoped, single-creation read.
      const response = await request<GenerationListResponse>(`/api/generations${buildQuery({ id, includeArchived: true, limit: 1 })}`);
      const generation = response.generations.find((item) => item.id === id);
      return generation ? normalizeGenerationMediaUrls(root, generation) : null;
    },
    archiveGeneration: (generationId: string) =>
      request(`/api/generations/${generationId}/archive`, { method: 'POST' }),
    restoreGeneration: (generationId: string) =>
      request(`/api/generations/${generationId}/restore`, { method: 'POST' }),
    // Deletes the row outright. A post made from it stays (`linkedPostRetained`),
    // and the files it shows are left in place.
    deleteGeneration: (generationId: string) =>
      request<{ success: true; deleted: true; linkedPostRetained: boolean; message: string }>(
        `/api/generations/${encodeURIComponent(generationId)}`,
        { method: 'DELETE' }
      ),
    startImageGeneration: (body: ImageGenerationRequest, idempotencyKey?: string) =>
      request<GenerationStartResponse>('/api/generate-image', generationStartInit(body, 'image', idempotencyKey), GENERATION_START_REQUEST_OPTIONS),
    getImageGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate-image${buildQuery({ id: predictionId })}`),
    startVideoGeneration: (body: VideoGenerationRequest, idempotencyKey?: string) =>
      request<GenerationStartResponse>('/api/generate-video', generationStartInit(body, 'video', idempotencyKey), GENERATION_START_REQUEST_OPTIONS),
    getVideoGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate-video${buildQuery({ id: predictionId })}`),
    // A reference registered with Seedance once (its storage path or signed link)
    // and read back until the provider reports it active or failed.
    createSeedanceAsset: (body: { url: string; assetType: SeedanceAssetKind }) =>
      request<SeedanceAssetResponse>('/api/seedance-assets', { method: 'POST', body: JSON.stringify(body) }),
    getSeedanceAsset: (assetId: string) =>
      request<SeedanceAssetResponse>(`/api/seedance-assets${buildQuery({ assetId })}`),
    startMotionGeneration: (body: MotionGenerationRequest, idempotencyKey?: string) =>
      request<GenerationStartResponse>('/api/generate', generationStartInit(body, 'motion', idempotencyKey), GENERATION_START_REQUEST_OPTIONS),
    getMotionGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate${buildQuery({ id: predictionId })}`),
    enhancePrompt: (body: PromptEnhancementRequest) =>
      request<PromptEnhancementResponse>('/api/enhance-prompt', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { [PROMPT_ENHANCE_WAIT_HEADER]: String(PROMPT_ENHANCE_TIMEOUT_MS) },
      }, PROMPT_ENHANCE_REQUEST_OPTIONS),
    getShowcaseFeed: (params?: Record<string, QueryValue>, options: RequestOptions = {}) =>
      request<ShowcaseFeedResponse>(`/api/showcase/feed${buildQuery(params)}`, {}, {
        ...(options.auth === false ? { cacheTtlMs: CONTENT_CACHE_TTL_MS } : {}),
        ...options,
      }),
    searchPublicContent: (params: {
      query: string;
      type?: PublicSearchType;
      cursor?: string | null;
      limit?: number;
    }, signal?: AbortSignal) => request<PublicSearchResponse>('/api/search' + buildQuery({
      q: params.query,
      type: params.type ?? 'top',
      cursor: params.cursor,
      limit: params.limit,
    }), { signal }, { auth: true }),
    recordShowcaseFeedEvent: (body: ShowcaseFeedEventRequest) =>
      request<ShowcaseFeedEventResponse>('/api/showcase/feed/events', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    recordShowcaseFeedEvents: (
      events: ShowcaseFeedEventRequest[],
      options: { accessToken: string | null },
    ) => request<ShowcaseFeedEventBatchResponse>('/api/showcase/feed/events', {
      method: 'POST',
      headers: options.accessToken
        ? { Authorization: `Bearer ${options.accessToken}` }
        : undefined,
      body: JSON.stringify({ events }),
    }, { auth: false }),
    // Sent without the session token: the probe is public and cacheable, and
    // the proxy would check (and refuse) an expired token it was given.
    getShowcaseFeedNewest: (params?: { category?: 'media' | 'text' | 'all' }) =>
      request<ShowcaseFeedNewestResponse>(`/api/showcase/feed/newest${buildQuery(params)}`, {}, { auth: false }),
    // Home's "Make this" shelf, with the session token whenever there is one. A
    // member's brings their own offers; a guest's, like a member's, leaves out
    // the creators and posts it blocked, hid or reported in the feed (a guest's
    // Not interested and Hide are kept under its uid, D1), which the answer the
    // edge shares between signed-out visitors cannot. Signed out, none is sent.
    getHomeShelf: () =>
      request<HomeShelfResponse>('/api/home/shelf'),
    undoFeedFeedback: (body: UndoFeedFeedbackRequest) =>
      request<UndoFeedFeedbackResponse>('/api/showcase/feed/feedback/undo', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getSavedMedia: (params?: Record<string, QueryValue>) =>
      request<ShowcaseFeedResponse>(`/api/showcase/saved-media${buildQuery(params)}`),
    // A 404 here is authoritative. This used to fall back to scanning a recent
    // feed page for the post, which cost a full feed fetch on every genuine
    // miss, only ever covered the newest page the server would return, and had
    // to forward auth by hand or it became a way around user blocks.
    revealNsfwPost: (postId: string) =>
      request<ShowcasePostResponse>(`/api/posts/${encodeURIComponent(postId)}/reveal`, { method: 'POST' }),
    getContentPreferences: () => request<{ showMature: boolean }>('/api/content-preferences'),
    getShowcasePost: (postId: string) =>
      request<ShowcasePostResponse>(`/api/showcase/posts/${postId}`),
    // Names the live post behind an id the by-id read did not find: an old
    // link carries a generation id, which the web's post page has always
    // followed. A post id answers with itself; anything else is a 404.
    resolveShowcasePost: (id: string) =>
      request<{ success: true; postId: string }>(`/api/showcase/posts/${encodeURIComponent(id)}/resolve`),
    listPostComments: (postId: string, params?: Record<string, QueryValue>) =>
      request<PostCommentsResponse>(
        `/api/showcase/posts/${encodeURIComponent(postId)}/comments${buildQuery(params)}`
      ),
    createPostComment: (postId: string, body: CreatePostCommentBody) =>
      request<CreatePostCommentResponse>(
        `/api/showcase/posts/${encodeURIComponent(postId)}/comments`,
        // The delivery only when there is one: a thread opened anywhere but a
        // ranked feed sends the body it always sent.
        { method: 'POST', body: JSON.stringify({ ...body, deliveryId: body.deliveryId || undefined }) }
      ),
    deletePostComment: (postId: string, commentId: string) =>
      request<DeletePostCommentResponse>(
        `/api/showcase/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'DELETE' }
      ),
    reportComment: (
      commentId: string,
      body: { reason: CommentReportReason; details?: string }
    ) => request<{ success: true }>('/api/moderation/reports', {
      method: 'POST',
      body: JSON.stringify({
        targetType: 'comment',
        targetId: commentId,
        sourceSurface: 'comments' satisfies ModerationReportSourceSurface,
        ...body,
      }),
    }),
    getCreatorProfile: (username: string, params?: Record<string, QueryValue>) =>
      request<CreatorProfileResponse>(`/api/creators/${encodeURIComponent(username)}${buildQuery(params)}`),
    reportPost: (
      postId: string,
      body: {
        reason: 'spam' | 'stolen_content' | 'misleading_unlock' | 'unsafe_content' | 'payment_issue' | 'other';
        details?: string;
        /**
         * The post's recipe (`post_resource_bundles.id`) when the report is
         * about it; the server checks it belongs to the post and files it with
         * the report.
         */
        bundleId?: string;
        /**
         * The feed delivery the post was reported from, when a ranked feed
         * showed it: the server files the report as that delivery's `report`
         * feed event.
         */
        deliveryId?: string;
      }
    ) => request<{ success: true }>(`/api/posts/${encodeURIComponent(postId)}/report`, {
      method: 'POST',
      // The delivery only when there is one: a report from anywhere but a
      // ranked feed sends the body it always sent.
      body: JSON.stringify({ ...body, deliveryId: body.deliveryId || undefined }),
    }),
    reportUser: (
      userId: string,
      body: { reason: UserReportReason; sourceSurface: ModerationReportSourceSurface; details?: string }
    ) => request<{ success: true }>('/api/moderation/reports', {
      method: 'POST',
      body: JSON.stringify({
        targetType: 'user',
        targetId: userId,
        ...body,
      }),
    }),
    reportGeneration: (
      generationId: string,
      body: { reason: GenerationReportReason; sourceSurface: ModerationReportSourceSurface; details?: string }
    ) => request<{ success: true }>('/api/moderation/reports', {
      method: 'POST',
      body: JSON.stringify({
        targetType: 'generation',
        targetId: generationId,
        ...body,
      }),
    }),
    reportTemplate: (
      templateId: string,
      body: { reason: TemplateReportReason; details?: string }
    ) => request<{ success: true }>('/api/moderation/reports', {
      method: 'POST',
      // No surface: a template is reported from its page alone, and the
      // server files it as that.
      body: JSON.stringify({
        targetType: 'template',
        targetId: templateId,
        ...body,
      }),
    }),
    listBlockedUsers: () =>
      request<{ success: true; blockedUsers: BlockedUser[]; hasMore: boolean }>('/api/moderation/blocks'),
    blockUser: (userId: string) =>
      request<{ success: true; blocked: boolean }>(`/api/moderation/blocks/${encodeURIComponent(userId)}`, {
        method: 'POST',
      }),
    unblockUser: (userId: string) =>
      request<{ success: true; blocked: boolean }>(`/api/moderation/blocks/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      }),
    getCreatorFollowState: (followingId: string) =>
      request<{ following: boolean }>(`/api/profile/follow${buildQuery({ followingId })}`),
    setCreatorFollowing: (followingId: string, following: boolean, attribution?: CreatorFollowAttribution | null) =>
      request<{ following: boolean }>('/api/profile/follow', {
        method: 'POST',
        body: JSON.stringify({
          followingId,
          following,
          ...(attribution?.postId ? { postId: attribution.postId } : {}),
          ...(attribution?.postId && attribution.deliveryId ? { deliveryId: attribution.deliveryId } : {}),
        }),
      }),
    saveShowcasePost: (postId: string, options: SaveShowcasePostOptions) =>
      request<SaveShowcasePostResponse>('/api/showcase/save', {
        method: 'POST',
        body: JSON.stringify({
          postId,
          shouldSave: options.shouldSave,
          ...(options.sourceSurface ? { sourceSurface: options.sourceSurface } : {}),
          ...(options.creatorSeesSaver ? { creatorSeesSaver: true } : {}),
          ...(options.saverNotYetTold ? { saverNotYetTold: true } : {}),
        }),
      }),
    recordSaverNotice: () =>
      request<SaverNoticeResponse>('/api/profile/saver-notice', { method: 'POST' }),
    remixShowcasePost: (postId: string) =>
      request<{ success: boolean; redirectTo?: string; prefill?: { prompt?: string; settings?: unknown } }>('/api/showcase/remix', {
        method: 'POST',
        body: JSON.stringify({ postId }),
      }),
    getRemixSourceBundle: (generationId: string, options: { postId?: string | null } = {}) =>
      request<RemixSourceBundle>(`/api/remix-source${buildQuery({ id: generationId, postId: options.postId })}`),
    // `sourceSurface` is required rather than defaulted: every mobile share used
    // to report 'detail-page' regardless of origin, which made three distinct
    // surfaces indistinguishable from each other and from the web detail page.
    shareShowcasePost: (postId: string, options: ShareShowcasePostOptions) =>
      request<{ success: boolean }>('/api/showcase/share', {
        method: 'POST',
        body: JSON.stringify({
          postId,
          sourceSurface: options.sourceSurface,
          channel: options.channel ?? 'native-share',
        }),
      }),
    // One open of a shared link: `sourceSurface` is the link's `s` exactly as
    // it arrived (the server counts a surface it does not know as the detail
    // page, as the web post page does), and a visit has no channel.
    recordShareVisit: (postId: string, sourceSurface: string) =>
      request<{ success: boolean }>('/api/showcase/share', {
        method: 'POST',
        body: JSON.stringify({ postId, eventType: 'share_visit', sourceSurface }),
      }),
    shareCreatorProfile: (username: string, options: ShareCreatorProfileOptions) =>
      request<{ success: boolean }>('/api/profile/share', {
        method: 'POST',
        body: JSON.stringify({
          username,
          sourceSurface: options.sourceSurface,
          channel: options.channel ?? 'native-share',
        }),
      }),
    publishGeneration: (body: Record<string, unknown>) =>
      request<CreatePostResponse>('/api/showcase/publish', { method: 'POST', body: JSON.stringify(body) }),
    createPost: (body: FormData) =>
      request<CreatePostResponse>('/api/posts', { method: 'POST', body }, POST_CREATE_REQUEST_OPTIONS),
    listSourceTools: () =>
      request<{ tools: SourceToolOption[] }>('/api/source-tools'),
    fetchModelCatalogCurrent: (query: string, etag?: string) => readCatalogTransport(`/current?${query}`, etag),
    fetchModelCatalogPage: (query: string) => readCatalogTransport(`/models?${query}`),
    fetchModelCatalogDetails: (query: string) => readCatalogTransport(`/details?${query}`),
    fetchModelCatalogModel: (id: string, query: string) => readCatalogTransport(`/models/${encodeURIComponent(id)}?${query}`),
    listGenerationModels: async (): Promise<GenerationModelCatalog> => {
      const response = await request<unknown>(
        `/api/generation-models?platform=mobile&schemaVersion=${catalogSchemaVersion}`,
        {},
        { auth: false, cacheTtlMs: CONTENT_CACHE_TTL_MS }
      );
      return parseGenerationModelCatalog(
        response,
        catalogSchemaVersion,
      );
    },
    fetchGenerationModels: async ({
      etag = null,
      forceRefresh = false,
    }: {
      etag?: string | null;
      forceRefresh?: boolean;
    } = {}): Promise<GenerationModelCatalogFetchResult> => {
      const path = `/api/generation-models?platform=mobile&schemaVersion=${catalogSchemaVersion}${forceRefresh ? '&refresh=1' : ''}`;
      const headers = new Headers();
      headers.set(REQUEST_ID_HEADER, createMobileRequestId());
      headers.set('x-magicbooklet-client', 'mobile');
      if (clientInfo) {
        headers.set('x-magicbooklet-app-version', clientInfo.appVersion);
        headers.set('x-magicbooklet-api-version', String(clientInfo.apiVersion));
        headers.set('x-magicbooklet-catalog-schema-version', String(clientInfo.catalogSchemaVersion));
      }
      if (etag && !forceRefresh) headers.set('If-None-Match', etag);
      const url = `${root}${path}`;
      let response: Response;
      try {
        response = await fetcher(url, {
          headers,
          ...(forceRefresh ? { cache: 'no-store' } : {}),
        });
      } catch (error) {
        throw new ApiError(networkFailureMessage(root), 0, {
          url,
          cause: error instanceof Error ? error.message : String(error),
        }, headers.get(REQUEST_ID_HEADER) ?? undefined);
      }
      const responseEtag = response.headers.get('etag') ?? etag;
      if (response.status === 304) {
        return { catalog: null, etag: responseEtag, notModified: true };
      }
      const body = await parseResponse(response);
      if (!response.ok) {
        throwHttpApiError(response.status, body, response.headers.get(REQUEST_ID_HEADER) ?? undefined, false);
      }
      return {
        catalog: parseGenerationModelCatalog(
          body,
          catalogSchemaVersion,
        ),
        etag: responseEtag,
        notModified: false,
      };
    },
    quoteGenerationModel: (body: GenerationModelQuoteRequest, signal?: AbortSignal) =>
      request<GenerationModelQuote>('/api/generation-models/quote', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
    ...(catalogSchemaVersion >= 2
      ? {
          startGeneration: (body: CatalogGenerationRequest, idempotencyKey?: string) =>
            request<GenerationStartResponse>(
              '/api/generations',
              generationStartInit(body, body.kind, idempotencyKey),
              GENERATION_START_REQUEST_OPTIONS,
            ),
        }
      : {}),
    signPostResourceFileUpload: (body: PostResourceFileSignRequest, signal?: AbortSignal) =>
      request<PostResourceFileSignResponse>('/api/posts/resource-files/sign', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
    finalizePostResourceFileUpload: (body: PostResourceFileFinalizeRequest, signal?: AbortSignal) =>
      request<PostResourceFileFinalizeResponse>('/api/posts/resource-files/finalize', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
    createMediaUpload: (body: MediaUploadIntentRequest) =>
      request<MediaUploadIntentResponse>('/api/uploads/media/sign', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    finalizeUpload: (body: UploadFinalizeRequest, signal?: AbortSignal) =>
      request<UploadFinalizeResponse>('/api/uploads/finalize', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
    createMediaReadUrl: (body: MediaReadUrlRequest) =>
      request<MediaReadUrlResponse>('/api/uploads/media/read-url', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listMediaTemplates: async (params?: Record<string, QueryValue>, options: MediaTemplateReadOptions = {}) => {
      const path = `/api/templates${buildQuery(params)}`;
      // A pull to refresh asks the server again, and the answer replaces the copy kept here.
      if (options.fresh) responseCache.delete(`${root}${path}`);
      const response = await request<unknown>(path, {}, {
        auth: false,
        cacheTtlMs: CONTENT_CACHE_TTL_MS,
      });
      return normalizeTemplateListMediaUrls(root, normalizeMediaTemplateListResponse(response));
    },
    getMediaTemplate: async (slug: string, options: MediaTemplateReadOptions & {
      /**
       * Send the session, so the owner reads their own draft or disabled
       * template with its status. A registered account only: the server
       * answers a guest's token on this read, and on the other authoring
       * routes under `/api/templates`, with 403. (Since D4 a guest's token is
       * taken on `POST /api/templates/:id/runs`, which starts a run of a
       * published template: `createMediaTemplateRun`.) The answer can be the
       * owner's, so it is never kept in the shared five-minute copy.
       */
      withSession?: boolean;
    } = {}) => {
      const path = `/api/templates/${encodeURIComponent(slug)}`;
      if (options.fresh) responseCache.delete(`${root}${path}`);
      const response = await request<unknown>(path, {}, options.withSession
        ? { auth: true }
        : { auth: false, cacheTtlMs: CONTENT_CACHE_TTL_MS });
      const normalized = normalizeMediaTemplateDetailResponse(response);
      const listNormalized = normalizeTemplateListMediaUrls(root, {
        success: normalized.success,
        templates: [normalized.template],
      });
      return {
        success: normalized.success,
        template: {
          ...normalized.template,
          ...listNormalized.templates[0],
        },
      } satisfies MediaTemplateDetailResponse;
    },
    createMediaTemplateRun: async (templateId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/templates/${encodeURIComponent(templateId)}/runs`,
        generationStartInit({}, 'template-run', idempotencyKey),
        GENERATION_START_REQUEST_OPTIONS,
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    getTemplateRun: async (runId: string) => {
      const response = await request<unknown>(`/api/template-runs/${encodeURIComponent(runId)}`);
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    signTemplateRunInput: (runId: string, body: TemplateRunInputSignRequest) =>
      request<TemplateRunInputSignResponse>(`/api/template-runs/${encodeURIComponent(runId)}/inputs/sign`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    finalizeTemplateRunInput: async (runId: string, body: TemplateRunInputFinalizeRequest) => {
      const response = await request<unknown>(`/api/template-runs/${encodeURIComponent(runId)}/inputs/finalize`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    startTemplateRun: async (runId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/template-runs/${encodeURIComponent(runId)}/start`,
        generationStartInit({}, 'template-run-start', idempotencyKey),
        GENERATION_START_REQUEST_OPTIONS,
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    retryTemplateRunStep: async (runId: string, stepId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/template-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/retry`,
        generationStartInit({}, 'template-step-retry', idempotencyKey),
        GENERATION_START_REQUEST_OPTIONS,
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    approveTemplateRunStep: async (runId: string, stepId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/template-runs/${encodeURIComponent(runId)}/approval-steps/${encodeURIComponent(stepId)}/approve`,
        generationStartInit({}, 'template-step-approve', idempotencyKey),
        GENERATION_START_REQUEST_OPTIONS,
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    cancelTemplateRun: async (runId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/template-runs/${encodeURIComponent(runId)}/cancel`,
        generationStartInit({}, 'template-cancel', idempotencyKey),
        GENERATION_START_REQUEST_OPTIONS,
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    createProfileMediaUpload: (body: ProfileMediaUploadIntentRequest) =>
      request<ProfileMediaUploadIntentResponse>('/api/profile/media/sign', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listPosts: (params?: Record<string, QueryValue>) => request(`/api/posts${buildQuery(params)}`),
    listOwnerPosts: (params?: OwnerPostsQuery) =>
      request<OwnerPostsResponse>(`/api/posts${buildQuery({ ...params, scope: 'owner' })}`),
    getOwnerPost: (postId: string) =>
      request<{
        success: boolean;
        post: OwnerPostListItem & {
          resourceBundleInput?: PostResourceBundleInput | null;
          hasPaidOrders?: boolean;
          /** People who have this recipe: paid sales plus free unlocks. */
          resourceBundleBuyerCount?: number;
        };
      }>(`/api/posts/${postId}`),
    updatePost: (postId: string, body: Record<string, unknown>) =>
      request<{ success: boolean; postId: string; visibility: string }>(`/api/posts/${postId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    archivePost: (postId: string) =>
      request<{ success: boolean; archived: boolean }>(`/api/posts/${postId}/archive`, { method: 'POST' }),
    restorePost: (postId: string) =>
      request<{ success: boolean; restored: boolean }>(`/api/posts/${postId}/restore`, { method: 'POST' }),
    deletePost: (postId: string, options: { force?: boolean } = {}) =>
      request<{ success: boolean; deleted: boolean }>(
        `/api/posts/${postId}`,
        {
          method: 'DELETE',
          ...(options.force ? { body: JSON.stringify({ force: true }) } : {}),
        }
      ),
    listMarketplaceResources: (params?: Record<string, QueryValue>) =>
      request<MarketplaceResourceList>(`/api/marketplace/resources${buildQuery(params)}`, {}, {
        auth: false,
        cacheTtlMs: CONTENT_CACHE_TTL_MS,
      }),
    /**
     * A recipe by its id, or, with no id, a post's own recipe: the Details
     * page asks a post it has no listing for, which answers a buyer whatever
     * the recipe's listing state (recipe audit B-F7).
     */
    getMarketplaceResourceDetail: async (resourceId: string | null, options?: { postId?: string | null }) => {
      if (!resourceId && options?.postId) {
        return request<MarketplaceResourceDetailResponse>(`/api/posts/${options.postId}/resource-bundle`);
      }
      try {
        return await request<MarketplaceResourceDetailResponse>(`/api/marketplace/resources/${resourceId}`);
      } catch (error) {
        if (!isNotFoundError(error) || !options?.postId) {
          throw error;
        }

        return request<MarketplaceResourceDetailResponse>(`/api/posts/${options.postId}/resource-bundle`);
      }
    },
    unlockFreeBundle: (postId: string) =>
      request<PostResourceBundleFreeUnlockResponse>(`/api/posts/${postId}/resource-bundle/unlock-free`, { method: 'POST' }),
    /**
     * `expectedPriceCredits` is the price the buyer confirmed. With it the
     * server charges nothing when the price has moved since, and answers 409
     * `RESOURCE_PRICE_CHANGED` with the price now (`priceCredits`); without it
     * (builds before that check) it charges the price it holds.
     */
    unlockBundleWithCredits: (postId: string, expectedPriceCredits?: number) =>
      request<MobileCommerceSyncResponse>(`/api/posts/${postId}/resource-bundle/unlock-with-credits`, {
        method: 'POST',
        ...(typeof expectedPriceCredits === 'number' ? { body: JSON.stringify({ expectedPriceCredits }) } : {}),
      }),
    listViewerUnlocks: (params?: { limit?: number; offset?: number }) => {
      const query = new URLSearchParams();
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return request<ViewerUnlocksResponse>(`/api/me/unlocks${suffix}`);
    },
    getViewerUnlock: (unlockId: string) =>
      request<ViewerUnlockDetailResponse>(`/api/me/unlocks/${encodeURIComponent(unlockId)}`),
    getViewerUnlockFileUrl,
    getViewerUnlockFileUrls,
    /**
     * A signed URL for one of a purchase's files, batched with every other
     * path asked for in the same tick, as `resolvePostResourceFileUrl` is.
     */
    resolveViewerUnlockFileUrl,
    getPostResourceFileUrl,
    getPostResourceFileUrls,
    /**
     * A signed URL for one of a post's bundle files, batched with every other
     * path asked for in the same tick (`createPostResourceFileUrlResolver`).
     */
    resolvePostResourceFileUrl,
    syncMobilePurchase: (body: Record<string, unknown>) =>
      request<MobileCommerceSyncResponse>('/api/mobile/commerce/sync', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    restoreMobilePurchases: () =>
      request<MobileCommerceRestoreResponse>('/api/mobile/commerce/restore', {
        method: 'POST',
      }),
    registerMobilePushToken: (body: MobilePushTokenRegistration) =>
      request<{ success: boolean }>('/api/mobile/notifications/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    // `scope: 'account'` retires every push token of the account, asked before a
    // sign-out of all devices; anything else retires the token or device named.
    unregisterMobilePushToken: (body?: Partial<MobilePushTokenRegistration> & { scope?: 'account' }, signal?: AbortSignal) =>
      request<{ success: boolean }>('/api/mobile/notifications/unregister', {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
        signal,
      }),
    /**
     * Newest first, by each alert's last event. `before` is the `updatedAt` of
     * the oldest alert held: the server answers the alerts whose last event is
     * older, so the Alerts list reads on past its first page.
     */
    listMobileNotifications: (params?: { limit?: number; before?: string | null; beforeId?: string | null }) =>
      request<MobileNotificationsResponse>(`/api/mobile/notifications${buildQuery(params)}`),
    markMobileNotificationsRead: (ids: string[]) =>
      request<{ success: boolean }>('/api/mobile/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    markAllMobileNotificationsRead: () =>
      request<{ success: boolean }>('/api/mobile/notifications/read-all', {
        method: 'POST',
      }),
    getMobileNotificationPreferences: () =>
      request<{ success: boolean; preferences: MobileNotificationPreferences }>('/api/mobile/notifications/preferences'),
    updateMobileNotificationPreferences: (body: Partial<MobileNotificationPreferences>) =>
      request<{ success: boolean; preferences: MobileNotificationPreferences }>('/api/mobile/notifications/preferences', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  };
}

export type MagicbookletApiClient = ReturnType<typeof createApiClient>;
