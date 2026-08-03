import type {
  AppVersionResponse,
  CreatePostResponse,
  CreatorProfileResponse,
  GenerationListItem,
  GenerationListResponse,
  GenerationStartResponse,
  GenerationStatusResponse,
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
  PostResourceAttachment,
  PostResourceBundleInput,
  RemixSourceBundle,
  ShowcaseFeedEventRequest,
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
  VideoGenerationRequest,
  ViewerUnlocksResponse,
  ViewerUnlockDetailResponse,
  GenerationShareSourceSurface,
  ProfileShareSourceSurface,
  ShareChannel,
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
} from './media-templates';

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
};

export interface SaveShowcasePostOptions {
  shouldSave: boolean;
  sourceSurface?: string;
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
export type ModerationReportSourceSurface =
  | 'showcase'
  | 'showcase-reel'
  | 'creator-profile'
  | 'generation-viewer'
  | 'comments';

const CONTENT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_API_REQUEST_TIMEOUT_MS = 30_000;
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
    } : {}),
    output_url: absolutizeMediaUrl(root, item.output_url),
    output_urls: item.output_urls?.map((url) => absolutizeMediaUrl(root, url)).filter((url): url is string => Boolean(url)),
    preview_url: previewUrl,
    previewUrl,
    media: item.media ? {
      ...item.media,
      url: absolutizeMediaUrl(root, item.media.url) ?? item.media.url,
      previewUrl: absolutizeMediaUrl(root, item.media.previewUrl),
    } : item.media,
    input_media: isTemplateResult
      ? []
      : item.input_media?.map((media) => ({
        ...media,
        url: absolutizeMediaUrl(root, media.url),
      })),
  };
}

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
      })),
      result: response.run.result ? {
        ...response.run.result,
        url: absolutizeMediaUrl(root, response.run.result.url) ?? response.run.result.url,
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

async function parseResponse(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function throwHttpApiError(status: number, body: unknown, requestId: string | undefined): never {
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
  const catalogSchemaVersion = clientInfo?.catalogSchemaVersion === GENERATION_MODEL_CATALOG_SCHEMA_VERSION
    ? GENERATION_MODEL_CATALOG_SCHEMA_VERSION
    : 1;
  const responseCache = new Map<string, {
    expiresAt: number;
    promise?: Promise<unknown>;
    value?: unknown;
  }>();

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

      if (options.auth !== false) {
        const token = await getAccessToken();
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
      }

      const url = `${root}${path}`;
      let response: Response;
      const requestController = new AbortController();
      const upstreamSignal = init.signal;
      const abortFromUpstream = () => requestController.abort(upstreamSignal?.reason);
      if (upstreamSignal?.aborted) {
        abortFromUpstream();
      } else {
        upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
      }
      const timeoutId = setTimeout(() => {
        requestController.abort(new Error(`Request timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      try {
        response = await fetcher(url, {
          ...init,
          headers,
          signal: requestController.signal,
        });
      } catch (error) {
        throw new ApiError(networkFailureMessage(root), 0, {
          url,
          cause: error instanceof Error ? error.message : String(error),
        }, requestId);
      } finally {
        clearTimeout(timeoutId);
        upstreamSignal?.removeEventListener('abort', abortFromUpstream);
      }
      const body = await parseResponse(response);
      const responseRequestId = response.headers.get(REQUEST_ID_HEADER) ?? requestId;

      if (!response.ok) {
        throwHttpApiError(response.status, body, responseRequestId);
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
    recordOnboardingEvent: async (body: OnboardingEventRequest) => {
      const installationId = await getInstallationId?.().catch(() => null);
      if (!installationId) return { success: false as const };
      return request<{ success: true }>('/api/onboarding/events', {
        method: 'POST',
        body: JSON.stringify({ ...body, installationId }),
      });
    },
    deleteAccount: (
      confirmation: 'DELETE',
      options: { appleAuthorizationCode?: string } = {},
    ) =>
      request<{ success: boolean; deleted: boolean }>('/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ confirmation, ...options }),
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
        detail: 'summary',
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
    archiveGeneration: (generationId: string) =>
      request(`/api/generations/${generationId}/archive`, { method: 'POST' }),
    restoreGeneration: (generationId: string) =>
      request(`/api/generations/${generationId}/restore`, { method: 'POST' }),
    startImageGeneration: (body: ImageGenerationRequest, idempotencyKey?: string) =>
      request<GenerationStartResponse>('/api/generate-image', generationStartInit(body, 'image', idempotencyKey)),
    getImageGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate-image${buildQuery({ id: predictionId })}`),
    startVideoGeneration: (body: VideoGenerationRequest, idempotencyKey?: string) =>
      request<GenerationStartResponse>('/api/generate-video', generationStartInit(body, 'video', idempotencyKey)),
    getVideoGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate-video${buildQuery({ id: predictionId })}`),
    startMotionGeneration: (body: MotionGenerationRequest, idempotencyKey?: string) =>
      request<GenerationStartResponse>('/api/generate', generationStartInit(body, 'motion', idempotencyKey)),
    getMotionGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate${buildQuery({ id: predictionId })}`),
    enhancePrompt: (body: PromptEnhancementRequest) =>
      request<PromptEnhancementResponse>('/api/enhance-prompt', { method: 'POST', body: JSON.stringify(body) }),
    getShowcaseFeed: (params?: Record<string, QueryValue>, options: RequestOptions = {}) =>
      request<ShowcaseFeedResponse>(`/api/showcase/feed${buildQuery(params)}`, {}, {
        ...(options.auth === false ? { cacheTtlMs: CONTENT_CACHE_TTL_MS } : {}),
        ...options,
      }),
    recordShowcaseFeedEvent: (body: ShowcaseFeedEventRequest) =>
      request<ShowcaseFeedEventResponse>('/api/showcase/feed/events', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getSavedMedia: (params?: Record<string, QueryValue>) =>
      request<ShowcaseFeedResponse>(`/api/showcase/saved-media${buildQuery(params)}`),
    getShowcasePost: async (postId: string) => {
      try {
        return await request<ShowcasePostResponse>(`/api/showcase/posts/${postId}`);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }

        const feed = await request<ShowcaseFeedResponse>(
          `/api/showcase/feed${buildQuery({ limit: 48, sort: 'recent' })}`
        );
        const item = feed.items.find((candidate) => candidate.id === postId);
        if (!item) {
          throw error;
        }

        return { success: true, item };
      }
    },
    listPostComments: (postId: string, params?: Record<string, QueryValue>) =>
      request<PostCommentsResponse>(
        `/api/showcase/posts/${encodeURIComponent(postId)}/comments${buildQuery(params)}`
      ),
    createPostComment: (postId: string, body: { body: string; parentId?: string | null }) =>
      request<CreatePostCommentResponse>(
        `/api/showcase/posts/${encodeURIComponent(postId)}/comments`,
        { method: 'POST', body: JSON.stringify(body) }
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
      body: { reason: 'spam' | 'stolen_content' | 'misleading_unlock' | 'unsafe_content' | 'payment_issue' | 'other'; details?: string }
    ) => request<{ success: true }>(`/api/posts/${encodeURIComponent(postId)}/report`, {
      method: 'POST',
      body: JSON.stringify(body),
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
    setCreatorFollowing: (followingId: string, following: boolean) =>
      request<{ following: boolean }>('/api/profile/follow', {
        method: 'POST',
        body: JSON.stringify({ followingId, following }),
      }),
    saveShowcasePost: (postId: string, options: SaveShowcasePostOptions) =>
      request<SaveShowcasePostResponse>('/api/showcase/save', {
        method: 'POST',
        body: JSON.stringify({
          postId,
          shouldSave: options.shouldSave,
          ...(options.sourceSurface ? { sourceSurface: options.sourceSurface } : {}),
        }),
      }),
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
      request<CreatePostResponse>('/api/posts', { method: 'POST', body }),
    listSourceTools: () =>
      request<{ tools: SourceToolOption[] }>('/api/source-tools'),
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
        throwHttpApiError(response.status, body, response.headers.get(REQUEST_ID_HEADER) ?? undefined);
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
    ...(catalogSchemaVersion === GENERATION_MODEL_CATALOG_SCHEMA_VERSION
      ? {
          startGeneration: (body: CatalogGenerationRequest, idempotencyKey?: string) =>
            request<GenerationStartResponse>(
              '/api/generations',
              generationStartInit(body, body.kind, idempotencyKey),
            ),
        }
      : {}),
    uploadPostResourceFile: (body: FormData) =>
      request<{ success: boolean; attachment: PostResourceAttachment }>('/api/posts/resource-files', {
        method: 'POST',
        body,
      }),
    createMediaUpload: (body: MediaUploadIntentRequest) =>
      request<MediaUploadIntentResponse>('/api/uploads/media/sign', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createMediaReadUrl: (body: MediaReadUrlRequest) =>
      request<MediaReadUrlResponse>('/api/uploads/media/read-url', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listMediaTemplates: async (params?: Record<string, QueryValue>) => {
      const response = await request<unknown>(`/api/templates${buildQuery(params)}`, {}, {
        auth: false,
        cacheTtlMs: CONTENT_CACHE_TTL_MS,
      });
      return normalizeTemplateListMediaUrls(root, normalizeMediaTemplateListResponse(response));
    },
    getMediaTemplate: async (slug: string) => {
      const response = await request<unknown>(`/api/templates/${encodeURIComponent(slug)}`, {}, {
        auth: false,
        cacheTtlMs: CONTENT_CACHE_TTL_MS,
      });
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
        generationStartInit({}, 'template-run', idempotencyKey)
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
        generationStartInit({}, 'template-run-start', idempotencyKey)
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    retryTemplateRunStep: async (runId: string, stepId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/template-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/retry`,
        generationStartInit({}, 'template-step-retry', idempotencyKey)
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    approveTemplateRunStep: async (runId: string, stepId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/template-runs/${encodeURIComponent(runId)}/approval-steps/${encodeURIComponent(stepId)}/approve`,
        generationStartInit({}, 'template-step-approve', idempotencyKey)
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    cancelTemplateRun: async (runId: string, idempotencyKey?: string) => {
      const response = await request<unknown>(
        `/api/template-runs/${encodeURIComponent(runId)}/cancel`,
        generationStartInit({}, 'template-cancel', idempotencyKey)
      );
      return normalizeTemplateRunMediaUrls(root, normalizeTemplateRunResponse(response));
    },
    createProfileMediaUpload: (body: ProfileMediaUploadIntentRequest) =>
      request<ProfileMediaUploadIntentResponse>('/api/profile/media/sign', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listPosts: (params?: Record<string, QueryValue>) => request(`/api/posts${buildQuery(params)}`),
    listOwnerPosts: (params?: Record<string, QueryValue>) =>
      request<OwnerPostsResponse>(`/api/posts${buildQuery({ ...params, scope: 'owner' })}`),
    getOwnerPost: (postId: string) =>
      request<{
        success: boolean;
        post: OwnerPostListItem & {
          resourceBundleInput?: PostResourceBundleInput | null;
          hasPaidOrders?: boolean;
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
    getMarketplaceResourceDetail: async (resourceId: string, options?: { postId?: string | null }) => {
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
      request<{ success: boolean; alreadyProcessed?: boolean }>(`/api/posts/${postId}/resource-bundle/unlock-free`, { method: 'POST' }),
    unlockBundleWithCredits: (postId: string) =>
      request<MobileCommerceSyncResponse>(`/api/posts/${postId}/resource-bundle/unlock-with-credits`, { method: 'POST' }),
    listViewerUnlocks: (params?: { limit?: number; offset?: number }) => {
      const query = new URLSearchParams();
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return request<ViewerUnlocksResponse>(`/api/me/unlocks${suffix}`);
    },
    getViewerUnlock: (unlockId: string) =>
      request<ViewerUnlockDetailResponse>(`/api/me/unlocks/${encodeURIComponent(unlockId)}`),
    getViewerUnlockFileUrl: (unlockId: string, storagePath: string) =>
      request<{ success: boolean; signedUrl: string }>(`/api/me/unlocks/${encodeURIComponent(unlockId)}/file-url`, {
        method: 'POST',
        body: JSON.stringify({ storagePath }),
      }),
    getPostResourceFileUrl: (postId: string, storagePath: string) =>
      request<{ success: boolean; signedUrl: string }>(`/api/posts/${postId}/resource-bundle/file-url`, {
        method: 'POST',
        body: JSON.stringify({ storagePath }),
      }),
    syncMobilePurchase: (body: Record<string, unknown>) =>
      request<MobileCommerceSyncResponse>('/api/mobile/commerce/sync', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    restoreMobilePurchases: () =>
      request<{ success: boolean; entitlements: MobileCommerceSyncResponse[] }>('/api/mobile/commerce/restore', {
        method: 'POST',
      }),
    registerMobilePushToken: (body: MobilePushTokenRegistration) =>
      request<{ success: boolean }>('/api/mobile/notifications/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    unregisterMobilePushToken: (body?: Partial<MobilePushTokenRegistration>) =>
      request<{ success: boolean }>('/api/mobile/notifications/unregister', {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    listMobileNotifications: (params?: Record<string, QueryValue>) =>
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
