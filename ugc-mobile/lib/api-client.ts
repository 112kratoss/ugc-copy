import type {
  CreatePostResponse,
  GenerationListItem,
  GenerationStartResponse,
  GenerationStatusResponse,
  ImageGenerationRequest,
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
  PromptEnhancementRequest,
  PromptEnhancementResponse,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
  VideoGenerationRequest,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetcher?: typeof fetch;
}

type QueryValue = string | number | boolean | null | undefined;
type RequestOptions = {
  auth?: boolean;
  cacheTtlMs?: number;
};

const CONTENT_CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/$/, '');
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
  return {
    ...item,
    output_url: absolutizeMediaUrl(root, item.output_url),
    output_urls: item.output_urls?.map((url) => absolutizeMediaUrl(root, url)).filter((url): url is string => Boolean(url)),
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

export function createApiClient({ baseUrl, getAccessToken, fetcher = fetch }: ApiClientOptions) {
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

      if (options.auth !== false) {
        const token = await getAccessToken();
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
      }

      const response = await fetcher(`${root}${path}`, {
        ...init,
        headers,
      });
      const body = await parseResponse(response);

      if (!response.ok) {
        const message =
          typeof body === 'object' && body && 'error' in body
            ? String((body as { error?: unknown }).error)
            : `Request failed with status ${response.status}`;
        throw new ApiError(message, response.status, body);
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
    startImageGeneration: (body: ImageGenerationRequest) =>
      request<GenerationStartResponse>('/api/generate-image', { method: 'POST', body: JSON.stringify(body) }),
    getImageGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate-image${buildQuery({ id: predictionId })}`),
    startVideoGeneration: (body: VideoGenerationRequest) =>
      request<GenerationStartResponse>('/api/generate-video', { method: 'POST', body: JSON.stringify(body) }),
    getVideoGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate-video${buildQuery({ id: predictionId })}`),
    startMotionGeneration: (body: MotionGenerationRequest) =>
      request<GenerationStartResponse>('/api/generate', { method: 'POST', body: JSON.stringify(body) }),
    getMotionGeneration: (predictionId: string) =>
      request<GenerationStatusResponse>(`/api/generate${buildQuery({ id: predictionId })}`),
    enhancePrompt: (body: PromptEnhancementRequest) =>
      request<PromptEnhancementResponse>('/api/enhance-prompt', { method: 'POST', body: JSON.stringify(body) }),
    getShowcaseFeed: (params?: Record<string, QueryValue>, options: RequestOptions = { auth: false }) =>
      request<ShowcaseFeedResponse>(`/api/showcase/feed${buildQuery(params)}`, {}, {
        cacheTtlMs: CONTENT_CACHE_TTL_MS,
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
    saveShowcasePost: (postId: string) =>
      request<{ success: boolean; isSaved: boolean | null; message?: string }>('/api/showcase/save', {
        method: 'POST',
        body: JSON.stringify({ postId }),
      }),
    remixShowcasePost: (postId: string) =>
      request<{ success: boolean; redirectTo?: string; prefill?: { prompt?: string; settings?: unknown } }>('/api/showcase/remix', {
        method: 'POST',
        body: JSON.stringify({ postId }),
      }),
    shareShowcasePost: (postId: string, channel: 'native-share' | 'copy-link' = 'native-share') =>
      request<{ success: boolean }>('/api/showcase/share', {
        method: 'POST',
        body: JSON.stringify({ postId, sourceSurface: 'detail-page', channel }),
      }, { auth: false }),
    publishGeneration: (body: Record<string, unknown>) =>
      request<CreatePostResponse>('/api/showcase/publish', { method: 'POST', body: JSON.stringify(body) }),
    createPost: (body: FormData) =>
      request<CreatePostResponse>('/api/posts', { method: 'POST', body }),
    listPosts: (params?: Record<string, QueryValue>) => request(`/api/posts${buildQuery(params)}`),
    listOwnerPosts: (params?: Record<string, QueryValue>) =>
      request<OwnerPostsResponse>(`/api/posts${buildQuery({ ...params, scope: 'owner' })}`),
    getOwnerPost: (postId: string) =>
      request<{ success: boolean; post: OwnerPostListItem & { resourceBundleInput?: any } }>(`/api/posts/${postId}`),
    updatePost: (postId: string, body: Record<string, unknown>) =>
      request<{ success: boolean; postId: string; visibility: string }>(`/api/posts/${postId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    archivePost: (postId: string) =>
      request<{ success: boolean; archived: boolean }>(`/api/posts/${postId}/archive`, { method: 'POST' }),
    restorePost: (postId: string) =>
      request<{ success: boolean; restored: boolean }>(`/api/posts/${postId}/restore`, { method: 'POST' }),
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
