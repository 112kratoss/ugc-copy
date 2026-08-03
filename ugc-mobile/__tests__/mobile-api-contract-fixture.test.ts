import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';
import { ApiError, createApiClient, type MagicbookletApiClient } from '../lib/api-client';

type ContractEndpointKey = keyof typeof mobileApiContract.endpoints;
type ContractEndpoint = {
  method: string;
  path: string;
  auth: string;
  cacheControl: string;
  status?: number;
  response: unknown;
};
const contract = mobileApiContract as { endpoints: Record<ContractEndpointKey, ContractEndpoint> };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function matchesPathTemplate(template: string, actualPath: string) {
  const templateParts = template.split('/').filter(Boolean);
  const actualParts = actualPath.split('/').filter(Boolean);
  return templateParts.length === actualParts.length
    && templateParts.every((part, index) => part.startsWith(':') || part === actualParts[index]);
}

function clientForEndpoint(endpointKey: ContractEndpointKey) {
  const endpoint = contract.endpoints[endpointKey];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const actualMethod = (init?.method ?? 'GET').toUpperCase();
    expect(actualMethod).toBe(endpoint.method);
    expect(matchesPathTemplate(endpoint.path, url.pathname)).toBe(true);
    return jsonResponse(endpoint.response, endpoint.status ?? 200);
  });

  return createApiClient({
    baseUrl: 'https://magicbooklet.test',
    getAccessToken: async () => 'token-1',
    fetcher: fetcher as unknown as typeof fetch,
  });
}

const successCases: Array<{
  key: Exclude<ContractEndpointKey, 'mobileUpdateRequired' | 'getPostResourceBundle'>;
  call: (api: MagicbookletApiClient) => Promise<unknown>;
}> = [
  { key: 'appVersion', call: (api) => api.getAppVersion() },
  { key: 'getProfile', call: (api) => api.getProfile() },
  { key: 'updateProfile', call: (api) => api.updateProfile({ displayName: 'Creator One' }) },
  { key: 'listGenerations', call: (api) => api.listGenerations(false) },
  { key: 'archiveGeneration', call: (api) => api.archiveGeneration('generation-1') },
  { key: 'restoreGeneration', call: (api) => api.restoreGeneration('generation-1') },
  { key: 'startImageGeneration', call: (api) => api.startImageGeneration({ model: 'nano-banana', prompt: 'A clean product shot.' }) },
  { key: 'getImageGeneration', call: (api) => api.getImageGeneration('prediction-1') },
  { key: 'startVideoGeneration', call: (api) => api.startVideoGeneration({ model: 'seedance-lite', prompt: 'A short reveal.' }) },
  { key: 'getVideoGeneration', call: (api) => api.getVideoGeneration('prediction-2') },
  {
    key: 'startMotionGeneration',
    call: (api) => api.startMotionGeneration({
      model: 'motion-basic',
      prompt: 'Animate the product rotation.',
      referenceVideoUrl: 'https://cdn.example.test/reference.mp4',
      characterImageUrl: 'https://cdn.example.test/character.png',
      duration: 5,
    }),
  },
  { key: 'getMotionGeneration', call: (api) => api.getMotionGeneration('prediction-3') },
  { key: 'enhancePrompt', call: (api) => api.enhancePrompt({ medium: 'image', selectedModel: 'nano-banana', prompt: 'Make it premium.' }) },
  { key: 'getShowcaseFeed', call: (api) => api.getShowcaseFeed({ limit: 10 }, { auth: false }) },
  { key: 'getSavedMedia', call: (api) => api.getSavedMedia({ limit: 10 }) },
  { key: 'getShowcasePost', call: (api) => api.getShowcasePost('post-1') },
  { key: 'listPostComments', call: (api) => api.listPostComments('post-1', { sort: 'top', limit: 20 }) },
  { key: 'createPostComment', call: (api) => api.createPostComment('post-1', { body: 'Nice work' }) },
  { key: 'deletePostComment', call: (api) => api.deletePostComment('post-1', 'comment-1') },
  { key: 'saveShowcasePost', call: (api) => api.saveShowcasePost('post-1', { shouldSave: true }) },
  { key: 'remixShowcasePost', call: (api) => api.remixShowcasePost('post-1') },
  { key: 'shareShowcasePost', call: (api) => api.shareShowcasePost('post-1', { sourceSurface: 'showcase-reel' }) },
  { key: 'shareCreatorProfile', call: (api) => api.shareCreatorProfile('nova', { sourceSurface: 'creator-profile' }) },
  { key: 'publishGeneration', call: (api) => api.publishGeneration({ generationId: 'generation-1', visibility: 'public' }) },
  { key: 'createPost', call: (api) => api.createPost(new FormData()) },
  { key: 'listSourceTools', call: (api) => api.listSourceTools() },
  { key: 'listGenerationModels', call: (api) => api.listGenerationModels() },
  {
    key: 'quoteGenerationModel',
    call: (api) => api.quoteGenerationModel({
      kind: 'image',
      modelId: 'nano-banana',
      settings: { aspectRatio: '1:1', resolution: '1K' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
      catalogRevision: 'catalog-rev-1',
    }),
  },
  { key: 'uploadPostResourceFile', call: (api) => api.uploadPostResourceFile(new FormData()) },
  {
    key: 'mediaUploadIntent',
    call: (api) => api.createMediaUpload({
      fileName: 'reference.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: 1234,
    }),
  },
  {
    key: 'mediaReadUrl',
    call: (api) => api.createMediaReadUrl({
      storagePath: 'uploads/user-1/reference.png',
    }),
  },
  {
    key: 'createProfileMediaUpload',
    call: (api) => api.createProfileMediaUpload({
      role: 'avatar',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
    }),
  },
  { key: 'listPosts', call: (api) => api.listPosts({ limit: 10 }) },
  { key: 'listOwnerPosts', call: (api) => api.listOwnerPosts({ limit: 10 }) },
  { key: 'getOwnerPost', call: (api) => api.getOwnerPost('post-1') },
  { key: 'updatePost', call: (api) => api.updatePost('post-1', { title: 'Updated post' }) },
  { key: 'archivePost', call: (api) => api.archivePost('post-1') },
  { key: 'restorePost', call: (api) => api.restorePost('post-1') },
  { key: 'deletePost', call: (api) => api.deletePost('post-1') },
  { key: 'listMarketplaceResources', call: (api) => api.listMarketplaceResources({ limit: 10 }) },
  { key: 'getMarketplaceResourceDetail', call: (api) => api.getMarketplaceResourceDetail('resource-1') },
  { key: 'unlockFreeBundle', call: (api) => api.unlockFreeBundle('post-1') },
  { key: 'unlockBundleWithCredits', call: (api) => api.unlockBundleWithCredits('post-1') },
  { key: 'getPostResourceFileUrl', call: (api) => api.getPostResourceFileUrl('post-1', 'bundles/post-1/prompt.txt') },
  {
    key: 'mobileCommerceSync',
    call: (api) => api.syncMobilePurchase({
      productId: 'credits-1',
      provider: 'app_store',
      transactionId: 'tx-1',
      receiptToken: 'receipt-1',
    }),
  },
  { key: 'mobileCommerceRestore', call: (api) => api.restoreMobilePurchases() },
  {
    key: 'registerMobilePushToken',
    call: (api) => api.registerMobilePushToken({
      expoPushToken: 'ExponentPushToken[test]',
      platform: 'ios',
      deviceId: 'device-1',
      appVersion: '1.0.0',
    }),
  },
  { key: 'unregisterMobilePushToken', call: (api) => api.unregisterMobilePushToken({ deviceId: 'device-1' }) },
  { key: 'mobileNotifications', call: (api) => api.listMobileNotifications({ limit: 10 }) },
  { key: 'markMobileNotificationsRead', call: (api) => api.markMobileNotificationsRead(['notification-1']) },
  { key: 'markAllMobileNotificationsRead', call: (api) => api.markAllMobileNotificationsRead() },
  { key: 'getMobileNotificationPreferences', call: (api) => api.getMobileNotificationPreferences() },
  { key: 'updateMobileNotificationPreferences', call: (api) => api.updateMobileNotificationPreferences({ pushEnabled: false }) },
];

type RegisteredOperationKey = keyof typeof mobileApiOperationsV1.operations;

const extendedOperationCases: Array<{
  key: RegisteredOperationKey;
  call: (api: MagicbookletApiClient) => Promise<unknown>;
}> = [
  {
    key: 'startGeneration',
    call: (api) => api.startGeneration?.({
      kind: 'video',
      modelId: 'seedance-2',
      catalogRevision: 'catalog-v2-revision',
      settings: { resolution: '1080p', duration: 7 },
      prompt: 'Create a cinematic reveal.',
      inputs: [],
    }) ?? Promise.reject(new Error('Catalog v2 start operation is unavailable.')),
  },
  { key: 'validateProfile', call: (api) => api.validateProfile({ displayName: 'Creator One' }) },
  { key: 'listViewerUnlocks', call: (api) => api.listViewerUnlocks({ limit: 24, offset: 0 }) },
  { key: 'getViewerUnlock', call: (api) => api.getViewerUnlock('unlock-1') },
  { key: 'getViewerUnlockFileUrl', call: (api) => api.getViewerUnlockFileUrl('unlock-1', 'retained/file.zip') },
  { key: 'getOnboardingState', call: (api) => api.getOnboardingState() },
  { key: 'updateOnboardingState', call: (api) => api.updateOnboardingState({ status: 'in_progress' }) },
  { key: 'getWelcomeCredits', call: (api) => api.getWelcomeCredits() },
  { key: 'claimWelcomeCredits', call: (api) => api.claimWelcomeCredits() },
  {
    key: 'recordOnboardingEvent',
    call: (api) => api.recordOnboardingEvent({
      clientEventId: 'event-1',
      eventName: 'started',
      platform: 'ios',
      occurredAt: '2026-07-14T12:00:00.000Z',
    }),
  },
  { key: 'deleteAccount', call: (api) => api.deleteAccount('DELETE') },
  { key: 'getReferralOverview', call: (api) => api.getReferralOverview() },
  { key: 'createReferralLink', call: (api) => api.createReferralLink() },
  { key: 'recordReferralVisit', call: (api) => api.recordReferralVisit({ code: 'CREATOR1', source: 'mobile' }) },
  { key: 'claimReferral', call: (api) => api.claimReferral({ code: 'CREATOR1' }) },
  {
    key: 'recordShowcaseFeedEvent',
    call: (api) => api.recordShowcaseFeedEvent({
      clientEventId: 'feed-event-1',
      postId: 'post-1',
      eventType: 'impression',
      sourceSurface: 'showcase',
    }),
  },
  { key: 'getCreatorProfile', call: (api) => api.getCreatorProfile('creator-one') },
  { key: 'reportPost', call: (api) => api.reportPost('post-1', { reason: 'unsafe_content' }) },
  {
    key: 'reportUser',
    call: (api) => api.reportUser('creator-1', { reason: 'harassment', sourceSurface: 'creator-profile' }),
  },
  {
    key: 'reportComment',
    call: (api) => api.reportComment('comment-1', { reason: 'harassment' }),
  },
  {
    key: 'reportGeneration',
    call: (api) => api.reportGeneration('generation-1', {
      reason: 'offensive_ai_output',
      sourceSurface: 'generation-viewer',
    }),
  },
  { key: 'blockUser', call: (api) => api.blockUser('creator-1') },
  { key: 'unblockUser', call: (api) => api.unblockUser('creator-1') },
  { key: 'getCreatorFollowState', call: (api) => api.getCreatorFollowState('creator-1') },
  { key: 'setCreatorFollowing', call: (api) => api.setCreatorFollowing('creator-1', true) },
  { key: 'getRemixSourceBundle', call: (api) => api.getRemixSourceBundle('generation-1') },
  { key: 'fetchGenerationModels', call: (api) => api.fetchGenerationModels() },
  { key: 'listMediaTemplates', call: (api) => api.listMediaTemplates({ limit: 10 }) },
  { key: 'getMediaTemplate', call: (api) => api.getMediaTemplate('product-reveal') },
  { key: 'createMediaTemplateRun', call: (api) => api.createMediaTemplateRun('template-1') },
  { key: 'getTemplateRun', call: (api) => api.getTemplateRun('run-1') },
  {
    key: 'signTemplateRunInput',
    call: (api) => api.signTemplateRunInput('run-1', {
      slotKey: 'product',
      fileName: 'product.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
    }),
  },
  {
    key: 'finalizeTemplateRunInput',
    call: (api) => api.finalizeTemplateRunInput('run-1', {
      inputs: [{ slotKey: 'product', storagePath: 'template_inputs/user-1/product.png' }],
    }),
  },
  { key: 'startTemplateRun', call: (api) => api.startTemplateRun('run-1') },
  { key: 'retryTemplateRunStep', call: (api) => api.retryTemplateRunStep('run-1', 'step-1') },
  { key: 'approveTemplateRunStep', call: (api) => api.approveTemplateRunStep('run-1', 'step-1') },
  { key: 'cancelTemplateRun', call: (api) => api.cancelTemplateRun('run-1') },
];

const legacyOperationAliases: Partial<Record<ContractEndpointKey, RegisteredOperationKey>> = {
  appVersion: 'getAppVersion',
  mediaUploadIntent: 'createMediaUpload',
  mediaReadUrl: 'createMediaReadUrl',
  mobileCommerceSync: 'syncMobilePurchase',
  mobileCommerceRestore: 'restoreMobilePurchases',
  mobileNotifications: 'listMobileNotifications',
};

describe('mobile shared API v1 contract fixture', () => {
  it('registers every public API client operation in the shared route contract', () => {
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      clientInfo: {
        appVersion: '1.0.0',
        apiVersion: 1,
        catalogSchemaVersion: 2,
      },
      fetcher: vi.fn() as unknown as typeof fetch,
    });
    const clientOperations = Object.keys(api).filter((key) => key !== 'request').sort();
    expect(clientOperations).toEqual(Object.keys(mobileApiOperationsV1.operations).sort());

    const exercisedOperations = [
      ...successCases.map(({ key }) => legacyOperationAliases[key] ?? key),
      ...extendedOperationCases.map(({ key }) => key),
    ].sort();
    expect(exercisedOperations).toEqual(Object.keys(mobileApiOperationsV1.operations).sort());
  });

  it.each(extendedOperationCases)('keeps $key aligned with its registered method and route', async ({ key, call }) => {
    const operation = mobileApiOperationsV1.operations[key];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect((init?.method ?? 'GET').toUpperCase()).toBe(operation.method);
      expect(matchesPathTemplate(operation.path, url.pathname)).toBe(true);
      return jsonResponse({});
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      getInstallationId: async () => 'installation-1',
      clientInfo: {
        appVersion: '1.0.0',
        apiVersion: 1,
        catalogSchemaVersion: 2,
      },
      fetcher: fetcher as unknown as typeof fetch,
    });

    await call(api).catch(() => undefined);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(successCases)('consumes the $key response example through the mobile API client', async ({ key, call }) => {
    const api = clientForEndpoint(key);
    await expect(call(api)).resolves.toEqual(contract.endpoints[key].response);
  });

  it('parses the shared update-required response as a typed API error', async () => {
    const endpoint = contract.endpoints.mobileUpdateRequired;
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      clientInfo: {
        appVersion: '0.9.0',
        apiVersion: 1,
        catalogSchemaVersion: 1,
      },
      fetcher: vi.fn(async () => new Response(JSON.stringify(endpoint.response), {
        status: endpoint.status,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch,
    });

    const error = await api.getProfile().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'UpgradeRequiredError',
      status: 426,
      code: 'MOBILE_UPDATE_REQUIRED',
      details: endpoint.response,
    });
  });

  it('consumes the marketplace bundle fallback response through the mobile API client', async () => {
    const detailEndpoint = contract.endpoints.getMarketplaceResourceDetail;
    const fallbackEndpoint = contract.endpoints.getPostResourceBundle;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      expect(method).toBe('GET');
      if (matchesPathTemplate(detailEndpoint.path, url.pathname)) {
        return jsonResponse({ error: 'Not found' }, 404);
      }
      expect(matchesPathTemplate(fallbackEndpoint.path, url.pathname)).toBe(true);
      return jsonResponse(fallbackEndpoint.response);
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.getMarketplaceResourceDetail('missing-resource', { postId: 'post-1' })).resolves.toEqual(
      fallbackEndpoint.response
    );
  });

  it('sends auth for mobile showcase share calls so social notifications can identify the actor', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/showcase/share');
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer token-1');
      return jsonResponse(contract.endpoints.shareShowcasePost.response);
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.shareShowcasePost('post-1', { sourceSurface: 'showcase-reel' }))
      .resolves.toEqual(contract.endpoints.shareShowcasePost.response);
  });
});
