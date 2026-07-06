import type {
  AppVersionResponse,
  CreatePostResponse,
  GenerationListItem,
  GenerationStartResponse,
  GenerationStatusResponse,
  ImageGenerationRequest,
  MediaReadUrlRequest,
  MediaReadUrlResponse,
  MediaUploadIntentRequest,
  MediaUploadIntentResponse,
  MarketplaceResourceList,
  MarketplaceResourceDetailResponse,
  MobileNotificationPreferences,
  MobileNotificationsResponse,
  MobilePushTokenRegistration,
  MobileCommerceSyncResponse,
  MotionGenerationRequest,
  OwnerPostListItem,
  OwnerPostsResponse,
  ProfileResponse,
  ProfileMediaUploadIntentRequest,
  ProfileMediaUploadIntentResponse,
  PromptEnhancementRequest,
  PromptEnhancementResponse,
  PostResourceAttachment,
  PostResourceBundleInput,
  RemixSourceBundle,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
  SourceToolOption,
  VideoGenerationRequest,
} from './types';
import {
  parseGenerationModelCatalog,
  type GenerationModelCatalog,
  type GenerationModelQuote,
  type GenerationModelQuoteRequest,
} from './generation-model-catalog';

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

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  clientInfo?: MobileClientInfo;
  fetcher?: typeof fetch;
}

export interface MobileClientInfo {
  appVersion: string;
  apiVersion: number;
  catalogSchemaVersion: number;
}

type QueryValue = string | number | boolean | null | undefined;
type RequestOptions = {
  auth?: boolean;
  cacheTtlMs?: number;
};

export interface SaveShowcasePostOptions {
  shouldSave: boolean;
  sourceSurface?: string;
}

export interface SaveShowcasePostResponse {
  success: boolean;
  isSaved: boolean;
  saveCount: number;
  changed: boolean;
  message?: string;
}

const CONTENT_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_ID_HEADER = 'x-request-id';

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

  return {
    ...item,
    output_url: absolutizeMediaUrl(root, item.output_url),
    output_urls: item.output_urls?.map((url) => absolutizeMediaUrl(root, url)).filter((url): url is string => Boolean(url)),
    preview_url: previewUrl,
    previewUrl,
    media: item.media ? {
      ...item.media,
      url: absolutizeMediaUrl(root, item.media.url) ?? item.media.url,
      previewUrl: absolutizeMediaUrl(root, item.media.previewUrl),
    } : item.media,
    input_media: item.input_media?.map((media) => ({
      ...media,
      url: absolutizeMediaUrl(root, media.url),
    })),
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

export function createApiClient({ baseUrl, getAccessToken, clientInfo, fetcher = fetch }: ApiClientOptions) {
  const root = normalizeBaseUrl(baseUrl);
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
      try {
        response = await fetcher(url, {
          ...init,
          headers,
        });
      } catch (error) {
        throw new ApiError(networkFailureMessage(root), 0, {
          url,
          cause: error instanceof Error ? error.message : String(error),
        }, requestId);
      }
      const body = await parseResponse(response);
      const responseRequestId = response.headers.get(REQUEST_ID_HEADER) ?? requestId;

      if (!response.ok) {
        const message =
          typeof body === 'object' && body && 'error' in body
            ? String((body as { error?: unknown }).error)
            : `Request failed with status ${response.status}`;
        const code = typeof body === 'object' && body && 'code' in body && typeof body.code === 'string'
          ? body.code
          : undefined;
        throw new ApiError(message, response.status, body, responseRequestId, code);
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
    updateProfile: (body: Partial<ProfileResponse>) =>
      request<ProfileResponse>('/api/profile', { method: 'PATCH', body: JSON.stringify(body) }),
    listGenerations: async (includeArchived = true) => {
      const response = await request<{ generations: GenerationListItem[] }>(`/api/generations${buildQuery({ includeArchived })}`);
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
          `/api/showcase/feed${buildQuery({ limit: 48, sort: 'recent' })}`,
          {},
          { auth: false, cacheTtlMs: CONTENT_CACHE_TTL_MS }
        );
        const item = feed.items.find((candidate) => candidate.id === postId);
        if (!item) {
          throw error;
        }

        return { success: true, item };
      }
    },
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
    shareShowcasePost: (postId: string, channel: 'native-share' | 'copy-link' = 'native-share') =>
      request<{ success: boolean }>('/api/showcase/share', {
        method: 'POST',
        body: JSON.stringify({ postId, sourceSurface: 'detail-page', channel }),
      }),
    publishGeneration: (body: Record<string, unknown>) =>
      request<CreatePostResponse>('/api/showcase/publish', { method: 'POST', body: JSON.stringify(body) }),
    createPost: (body: FormData) =>
      request<CreatePostResponse>('/api/posts', { method: 'POST', body }),
    listSourceTools: () =>
      request<{ tools: SourceToolOption[] }>('/api/source-tools'),
    listGenerationModels: async (): Promise<GenerationModelCatalog> => {
      const response = await request<unknown>(
        '/api/generation-models?platform=mobile&schemaVersion=1',
        {},
        { auth: false, cacheTtlMs: CONTENT_CACHE_TTL_MS }
      );
      return parseGenerationModelCatalog(response);
    },
    quoteGenerationModel: (body: GenerationModelQuoteRequest, signal?: AbortSignal) =>
      request<GenerationModelQuote>('/api/generation-models/quote', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      }),
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
    createProfileMediaUpload: (body: ProfileMediaUploadIntentRequest) =>
      request<ProfileMediaUploadIntentResponse>('/api/profile/media/sign', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listPosts: (params?: Record<string, QueryValue>) => request(`/api/posts${buildQuery(params)}`),
    listOwnerPosts: (params?: Record<string, QueryValue>) =>
      request<OwnerPostsResponse>(`/api/posts${buildQuery({ ...params, scope: 'owner' })}`),
    getOwnerPost: (postId: string) =>
      request<{ success: boolean; post: OwnerPostListItem & { resourceBundleInput?: PostResourceBundleInput | null } }>(`/api/posts/${postId}`),
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
