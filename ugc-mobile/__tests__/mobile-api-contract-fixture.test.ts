import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';
import { ApiError, POST_RESOURCE_FILE_URL_BATCH_LIMIT, createApiClient, type MagicbookletApiClient } from '../lib/api-client';
import { createFeedAttentionTracker, feedAttentionEventDetails } from '../lib/feed-attention-view-model';
import { buildImmersiveGenerationItems, buildImmersiveShowcaseItems } from '../lib/immersive-preview-view-model';
import { buildShowcaseFeedEventRequest } from '../lib/showcase-feed-events';
import type { ShowcaseFeedEventRequest, ShowcaseFeedEventType, UndoFeedFeedbackRequest } from '../lib/types';
import { getShowcaseViewerImageUrl } from '../lib/showcase-media';
import { isAmbiguousGenerationStartFailure } from '../lib/generation-attempts';

type ContractEndpointKey = keyof typeof mobileApiContract.endpoints;
type ContractEndpoint = {
  method: string;
  path: string;
  auth: string;
  cacheControl: string;
  status?: number;
  request?: unknown;
  query?: Record<string, string>;
  response: unknown;
};
const contract = mobileApiContract as { endpoints: Record<ContractEndpointKey, ContractEndpoint> };

it('exposes the shared invalid diagnostics timestamp as a typed API error', async () => {
  const operation = mobileApiOperationsV1.operations.reportMediaDiagnostics;
  const fixture = operation.invalidTimestamp;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual(fixture.request);
    return new Response(JSON.stringify(fixture.response), {
      status: fixture.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': fixture.cacheControl },
    });
  });
  const api = createApiClient({
    baseUrl: 'https://magicbooklet.test',
    getAccessToken: async () => 'token-1',
    fetcher: fetcher as unknown as typeof fetch,
  });
  await expect(api.reportMediaDiagnostics(fixture.request as Parameters<MagicbookletApiClient['reportMediaDiagnostics']>[0]))
    .rejects.toMatchObject({ status: fixture.status, message: fixture.response.error });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

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
    for (const [key, value] of Object.entries(endpoint.query ?? {})) {
      expect(url.searchParams.get(key)).toBe(value);
    }
    if (endpoint.request) {
      expect(JSON.parse(String(init?.body))).toEqual(endpoint.request);
    }
    return jsonResponse(endpoint.response, endpoint.status ?? 200);
  });

  return createApiClient({
    baseUrl: 'https://magicbooklet.test',
    getAccessToken: async () => 'token-1',
    fetcher: fetcher as unknown as typeof fetch,
  });
}

function withAbsoluteMediaRoutes(value: unknown, base: string): unknown {
  if (typeof value === 'string') return value.startsWith('/api/media?') ? `${base}${value}` : value;
  if (Array.isArray(value)) return value.map((item) => withAbsoluteMediaRoutes(item, base));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withAbsoluteMediaRoutes(v, base)]));
  }
  return value;
}

it('preserves private generation playback without replacing the original download URL', async () => {
  const payload = await clientForEndpoint('listGenerations').listGenerations(false);
  const video = payload.generations.find(generation => generation.id === 'private-video-1');
  // A relative authenticated-route URL is absolutized against the API root.
  expect(video?.media?.renditionUrl).toBe('https://magicbooklet.test/api/media?bucket=generated_videos&path=owner-1%2Fplayback%2Fprivate-video-1%2Fabc123.mp4');
  expect(video?.media?.url).toBe(video?.output_url);
  expect(video?.output_url).toBe('https://storage.example.test/private-video-original.mp4');
});

it('opens an owner image on its display rendition and keeps the original for downloads', async () => {
  // The whole path, contract payload to viewer source: the adapter that dropped
  // `displayUrl` passed while the helper was only ever handed a hand-built item.
  const payload = await clientForEndpoint('listGenerations').listGenerations(false);
  const image = payload.generations.find(generation => generation.id === 'generation-1');
  const [item] = buildImmersiveGenerationItems('profile-creations', image ? [image] : [], { creatorLabel: '@owner' });
  expect(getShowcaseViewerImageUrl(item.mediaItems[0])).toBe('https://cdn.example.test/generation-1-display.webp');
  expect(item.mediaItems[0].url).toBe('https://cdn.example.test/generation-1.png');
});

it('shows the caption a post read by id carries as its story when it has no body', async () => {
  // Contract payload to details page: the by-id read is where the web
  // composer's description reaches the app at all.
  const { item } = await clientForEndpoint('getShowcasePost').getShowcasePost('post-1');
  expect(item.description).toBe('A clean launch visual.');

  const [withBody] = buildImmersiveShowcaseItems('showcase-feed', [item]);
  expect(withBody.details?.body).toBe('Reusable launch notes.');
  const [withoutBody] = buildImmersiveShowcaseItems('showcase-feed', [{ ...item, body: '' }]);
  expect(withoutBody.details?.body).toBe('A clean launch visual.');
});

it('plays an audio creation from the owner library as sound, never as a picture', async () => {
  // The whole path again, contract payload to reel item. The server sends an
  // audio creation with no `media` descriptor, and the app once read that as
  // an image whose file could not be drawn.
  const payload = await clientForEndpoint('listGenerations').listGenerations(false);
  const voiceover = payload.generations.find(generation => generation.id === 'voiceover-1');
  const [item] = buildImmersiveGenerationItems('studio-creations', voiceover ? [voiceover] : [], { creatorLabel: '@owner' });
  expect(item).toMatchObject({
    previewKind: 'audio',
    badge: 'Voiceover',
    mediaKind: null,
    mediaUrl: null,
    mediaItems: [],
    audio: { url: 'https://storage.example.test/generated_audio/owner-1/generated_task.mp3', kind: 'voiceover' },
  });
});

const successCases: Array<{
  key: Exclude<ContractEndpointKey, 'mobileUpdateRequired' | 'getPostResourceBundle'>;
  call: (api: MagicbookletApiClient) => Promise<unknown>;
}> = [
  { key: 'appVersion', call: (api) => api.getAppVersion() },
  { key: 'getProfile', call: (api) => api.getProfile() },
  { key: 'updateProfile', call: (api) => api.updateProfile({ displayName: 'Creator One' }) },
  {
    key: 'deleteAccount',
    call: (api) => api.deleteAccount('DELETE', {
      appleAuthorizationCode: 'fresh-one-time-apple-code',
    }),
  },
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
  { key: 'getShowcaseFeed', call: (api) => api.getShowcaseFeed({ limit: 10, ...mobileApiContract.endpoints.getShowcaseFeed.query }, { auth: false }) },
  { key: 'getSavedMedia', call: (api) => api.getSavedMedia({ limit: 10 }) },
  { key: 'getShowcasePost', call: (api) => api.getShowcasePost('post-1') },
  { key: 'listPostComments', call: (api) => api.listPostComments('post-1', { sort: 'top', limit: 20 }) },
  {
    key: 'createPostComment',
    call: (api) => api.createPostComment('post-1', { body: 'Saving this for later.', parentId: null, deliveryId: '9001' }),
  },
  { key: 'deletePostComment', call: (api) => api.deletePostComment('post-1', 'comment-1') },
  {
    key: 'setCreatorFollowing',
    call: (api) => api.setCreatorFollowing('creator-1', true, {
      postId: '5f0c6a52-8d1e-4b7a-9c3f-1a2b3c4d5e6f',
      deliveryId: '9001',
    }),
  },
  {
    key: 'recordShowcaseFeedEvents',
    call: (api) => api.recordShowcaseFeedEvents(
      mobileApiContract.endpoints.recordShowcaseFeedEvents.request.events as Array<ShowcaseFeedEventRequest & { occurredAt: string }>,
      { accessToken: 'captured-token' },
    ),
  },
  { key: 'getShowcaseFeedNewest', call: (api) => api.getShowcaseFeedNewest({ category: 'media' }) },
  {
    key: 'undoFeedFeedback',
    call: (api) => api.undoFeedFeedback(mobileApiContract.endpoints.undoFeedFeedback.request as UndoFeedFeedbackRequest),
  },
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
  {
    key: 'signPostResourceFileUpload',
    call: (api) => api.signPostResourceFileUpload({
      fileName: 'prompt.txt',
      contentType: 'text/plain',
      sizeBytes: 256,
    }),
  },
  {
    key: 'finalizePostResourceFileUpload',
    call: (api) => api.finalizePostResourceFileUpload({
      path: 'user-1/11111111-1111-4111-8111-111111111111-prompt.txt',
      fileName: 'prompt.txt',
      contentType: 'text/plain',
      sizeBytes: 256,
    }),
  },
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
    key: 'finalizeUpload',
    call: (api) => api.finalizeUpload({
      uploadId: '11111111-1111-4111-8111-111111111111',
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
  { key: 'getContentPreferences', call: (api) => api.getContentPreferences() },
  { key: 'revealNsfwPost', call: (api) => api.revealNsfwPost('post-1') },
  { key: 'getGenerationDetails', call: (api) => api.getGenerationDetails('generation-1') },
  { key: 'deleteGeneration', call: (api) => api.deleteGeneration('generation-1') },
  { key: 'createSeedanceAsset', call: (api) => api.createSeedanceAsset({ url: 'uploads/user/reference.mp4', assetType: 'Video' }) },
  { key: 'getSeedanceAsset', call: (api) => api.getSeedanceAsset('asset-1') },
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
  { key: 'prepareGuestAccountMerge', call: (api) => api.prepareGuestAccountMerge() },
  {
    key: 'mergeGuestAccount',
    call: (api) => api.mergeGuestAccount('a'.repeat(64)),
  },
  { key: 'listViewerUnlocks', call: (api) => api.listViewerUnlocks({ limit: 24, offset: 0 }) },
  { key: 'getViewerUnlock', call: (api) => api.getViewerUnlock('unlock-1') },
  { key: 'getViewerUnlockFileUrl', call: (api) => api.getViewerUnlockFileUrl('unlock-1', 'retained/file.zip') },
  {
    key: 'getViewerUnlockFileUrls',
    call: (api) => api.getViewerUnlockFileUrls('unlock-1', ['retained/a.png', 'retained/b.png'], { disposition: 'inline' }),
  },
  { key: 'resolveViewerUnlockFileUrl', call: (api) => api.resolveViewerUnlockFileUrl('unlock-1', 'retained/file.zip') },
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
  { key: 'getReferralOverview', call: (api) => api.getReferralOverview() },
  { key: 'createReferralLink', call: (api) => api.createReferralLink() },
  { key: 'recordReferralVisit', call: (api) => api.recordReferralVisit({ code: 'CREATOR1', source: 'mobile' }) },
  { key: 'claimReferral', call: (api) => api.claimReferral({ code: 'CREATOR1' }) },
  {
    key: 'reportMediaDiagnostics',
    call: (api) => api.reportMediaDiagnostics({
      sessionId: 'session-1234',
      app: { version: '0.1.4', build: '71', update: '0558882d' },
      events: [{ at: 1, kind: 'image', event: 'stall', surface: 'profile-grid', subject: '8a1f09c2', attempt: 0 }],
    }),
  },
  {
    key: 'reportPlaybackMetrics',
    call: (api) => api.reportPlaybackMetrics({
      sessionId: 'session-1234',
      app: { version: '0.1.4', build: '72', update: '0558882d' },
      device: { platform: 'android', os: '15', model: 'samsung SM-S928B', network: 'wifi' },
      spanMs: 65000,
      buckets: [{ surface: 'viewer', kind: 'warm', starts: 1, startTotalMs: 40, startMaxMs: 40, samples: [40], stalls: 0, stallTotalMs: 0, stallMaxMs: 0 }],
    }),
  },
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
  { key: 'searchPublicContent', call: (api) => api.searchPublicContent({ query: 'product', type: 'top' }) },
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
  { key: 'listBlockedUsers', call: (api) => api.listBlockedUsers() },
  { key: 'blockUser', call: (api) => api.blockUser('creator-1') },
  { key: 'unblockUser', call: (api) => api.unblockUser('creator-1') },
  { key: 'getCreatorFollowState', call: (api) => api.getCreatorFollowState('creator-1') },
  { key: 'getRemixSourceBundle', call: (api) => api.getRemixSourceBundle('generation-1') },
  { key: 'fetchModelCatalogCurrent', call: (api) => api.fetchModelCatalogCurrent('platform=mobile') },
  { key: 'fetchModelCatalogPage', call: (api) => api.fetchModelCatalogPage('platform=mobile&revision=test&kind=image') },
  { key: 'fetchModelCatalogDetails', call: (api) => api.fetchModelCatalogDetails('platform=mobile&revision=test&ids=model-1') },
  { key: 'fetchModelCatalogModel', call: (api) => api.fetchModelCatalogModel('model-1', 'platform=mobile&revision=test') },
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
  {
    key: 'getPostResourceFileUrls',
    call: (api) => api.getPostResourceFileUrls('post-1', ['bundles/post-1/a.png', 'bundles/post-1/b.png'], { disposition: 'inline' }),
  },
  { key: 'resolvePostResourceFileUrl', call: (api) => api.resolvePostResourceFileUrl('post-1', 'bundles/post-1/prompt.txt') },
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
  it('preserves the owner library dimensions for layout', async () => {
    const result = await clientForEndpoint('listGenerations').listGenerations(true);
    expect(result.generations[0].media).toMatchObject({ width: 720, height: 405 });
  });

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
    // A retired operation stays in the registry so shipped builds that still
    // call it keep getting CORS and version headers on the route's 410, but
    // this client no longer has a method for it. Media redirects are consumed
    // by native players/images, not the JSON client.
    const liveOperations = Object.entries(mobileApiOperationsV1.operations)
      .filter(([, operation]) => !('retired' in operation) && !('transport' in operation && operation.transport === 'native-media'))
      .map(([key]) => key)
      .sort();

    const clientOperations = Object.keys(api).filter((key) => key !== 'request').sort();
    expect(clientOperations).toEqual(liveOperations);

    const exercisedOperations = [
      ...successCases.map(({ key }) => legacyOperationAliases[key] ?? key),
      ...extendedOperationCases.map(({ key }) => key),
    ].sort();
    expect(exercisedOperations).toEqual(liveOperations);
  });

  it.each(extendedOperationCases)('keeps $key aligned with its registered method and route', async ({ key, call }) => {
    const operation = mobileApiOperationsV1.operations[key];
    // What the client asked for is kept and checked after the call: an
    // expectation that fails in here is thrown into the client, and the catch
    // below, which is there for an empty answer, swallowed it. A call to the
    // wrong address or with the wrong method passed.
    const asked: Array<{ method: string; path: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(String(input)).pathname });
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
    expect(asked[0].method).toBe(operation.method);
    expect(matchesPathTemplate(operation.path, asked[0].path), `${key} asked for ${asked[0].path}`).toBe(true);
  });

  it.each(successCases)('consumes the $key response example through the mobile API client', async ({ key, call }) => {
    const api = clientForEndpoint(key);
    // The wire carries private playback as a relative authenticated-route URL;
    // the client absolutizes it against its base, so the expectation does too.
    await expect(call(api)).resolves.toEqual(withAbsoluteMediaRoutes(contract.endpoints[key].response, 'https://magicbooklet.test'));
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

  it("signs a bundle's files in the shared batch shapes, within the shared limit", async () => {
    const endpoint = contract.endpoints.getPostResourceFileUrl as unknown as ContractEndpoint & {
      batchLimit: number;
      requestVariants: { batch: { storagePaths: string[]; disposition: 'inline' | 'attachment' } };
      responseVariants: { batch: { files: Array<{ storagePath: string; url: string }> } };
    };
    const batch = endpoint.requestVariants.batch;
    expect(POST_RESOURCE_FILE_URL_BATCH_LIMIT).toBe(endpoint.batchLimit);

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(matchesPathTemplate(endpoint.path, new URL(String(input)).pathname)).toBe(true);
      expect((init?.method ?? 'GET').toUpperCase()).toBe(endpoint.method);
      return jsonResponse(endpoint.responseVariants.batch);
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const urls = await Promise.all(batch.storagePaths.map((storagePath) => (
      api.resolvePostResourceFileUrl('post-1', storagePath, { disposition: batch.disposition })
    )));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body))).toEqual(batch);
    expect(urls).toEqual(endpoint.responseVariants.batch.files.map((file) => file.url));
  });

  it('treats a path the batch answer leaves out as not found, without asking again', async () => {
    const endpoint = contract.endpoints.getPostResourceFileUrl as unknown as ContractEndpoint & {
      requestVariants: { batch: { storagePaths: string[]; disposition: 'inline' | 'attachment' } };
      responseVariants: { batch: { files: Array<{ storagePath: string; url: string }> } };
    };
    const [kept, ...rest] = endpoint.responseVariants.batch.files;
    expect(rest.length).toBeGreaterThan(0);
    // The route leaves out a path that is not on the unlock rather than
    // failing the paths beside it.
    const fetcher = vi.fn(async () => jsonResponse({ files: [kept] }));
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    const results = await Promise.allSettled(endpoint.requestVariants.batch.storagePaths.map((storagePath) => (
      api.resolvePostResourceFileUrl('post-1', storagePath, { disposition: endpoint.requestVariants.batch.disposition })
    )));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({ status: 'fulfilled', value: kept!.url });
    for (const missing of results.slice(1)) {
      expect(missing.status).toBe('rejected');
      expect((missing as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
      expect(((missing as PromiseRejectedResult).reason as ApiError).status).toBe(404);
    }
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

  // Feed ranking v4, §4: what Home now reports, built the way Home builds it,
  // is the batch the contract pins and the server's parser takes
  // (`src/__tests__/mobile-api-contract-fixture.test.ts`).
  it('builds the Home feed attention events the contract pins', () => {
    const pinned = mobileApiContract.endpoints.recordShowcaseFeedEvents.request.events;
    const item = {
      postId: pinned[0].postId,
      recommendation: { deliveryId: pinned[0].deliveryId, position: pinned[0].position, algorithmVersion: 'for-you-rules:4' },
    };
    const tracker = createFeedAttentionTracker<typeof item>((target) => target.recommendation.deliveryId);
    tracker.setActive(true, 0);
    tracker.setVisible([item], 1_000);
    const progress = tracker.recordProgress(item, 0.5, 95_500);
    const dwell = tracker.setVisible([], 5_200);
    const build = (eventType: ShowcaseFeedEventType, details = {}) => buildShowcaseFeedEventRequest(item, eventType, {
      feedSessionId: pinned[0].feedSessionId,
      algorithmVersion: item.recommendation.algorithmVersion,
      sourceSurface: 'feed',
    }, { ...details, metadata: { surface: 'home-feed' } });
    const built = [
      ...dwell.map((event) => build(event.eventType, feedAttentionEventDetails(event))),
      ...progress.map((event) => build(event.eventType, feedAttentionEventDetails(event))),
      build('resource_open'),
    ];

    // The queue stamps `occurredAt`; every event has its own id.
    expect(built.map(({ clientEventId: _id, ...event }) => event))
      .toEqual(pinned.map(({ clientEventId: _id, occurredAt: _at, ...event }) => event));
  });

  it('sends a comment and a follow with the delivery only when there is one', async () => {
    const bodies: unknown[] = [];
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ success: true, following: false, comment: {}, commentCount: 1 });
      }) as unknown as typeof fetch,
    });

    await api.createPostComment('post-1', { body: 'Plain', parentId: null, deliveryId: null });
    await api.createPostComment('post-1', { body: 'Reply', parentId: 'comment-1' });
    await api.setCreatorFollowing('creator-1', false);
    await api.setCreatorFollowing('creator-1', true, { postId: 'post-1', deliveryId: null });

    expect(bodies).toEqual([
      { body: 'Plain', parentId: null },
      { body: 'Reply', parentId: 'comment-1' },
      { followingId: 'creator-1', following: false },
      { followingId: 'creator-1', following: true, postId: 'post-1' },
    ]);
  });

  // The "New posts" probe is public and cacheable; the undo deletes the caller's own row (D2, D7).
  it('asks the newest probe without a token and sends an undo with one, in the shared shapes', async () => {
    const newest = mobileApiContract.endpoints.getShowcaseFeedNewest;
    const undo = mobileApiContract.endpoints.undoFeedFeedback;
    expect(newest.auth).toBe('none');
    expect(undo.auth).toBe('required');
    const asked: Array<{ method: string; path: string; query: string; authorization: string | null; body: unknown }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        query: url.search,
        authorization: new Headers(init?.headers).get('Authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse(url.pathname === newest.path
        ? newest.responseVariants.emptyLane
        : undo.responseVariants.nothingToRemove);
    });
    const api = createApiClient({
      baseUrl: 'https://magicbooklet.test',
      getAccessToken: async () => 'token-1',
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(api.getShowcaseFeedNewest({ category: 'text' })).resolves.toEqual({ newestPostId: null, newestPublishedAt: null });
    await expect(api.undoFeedFeedback(undo.requestVariants.hideCreator as UndoFeedFeedbackRequest))
      .resolves.toEqual({ ok: true, removed: false });

    expect(asked).toEqual([
      { method: 'GET', path: newest.path, query: '?category=text', authorization: null, body: null },
      { method: 'POST', path: undo.path, query: '', authorization: 'Bearer token-1', body: undo.requestVariants.hideCreator },
    ]);
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

 it('keeps uploaded-media redirects optional-auth and uncacheable', () => {
  expect(mobileApiContract.endpoints.readPostMedia).toMatchObject({
    path: '/api/media', auth: 'optional', status: 302, cacheControl: 'private, no-store',
  });
});

it.each(['getImageGeneration', 'getVideoGeneration', 'getMotionGeneration'] as const)(
  '%s preserves the retryable output-pending response', async (operation) => {
    const response = mobileApiContract.endpoints[operation].responseVariants.outputPending;
    const api = createApiClient({
      baseUrl: 'https://example.test',
      getAccessToken: async () => 'test-token',
      fetcher: vi.fn(async () => jsonResponse(response)),
    });
    const result = await api[operation]('prediction-pending');
    expect(result).toEqual(response);
    expect(result.status).toBe('processing');
    expect(result.output).toBeNull();
  },
);

it.each(['getVideoGeneration', 'getMotionGeneration'] as const)(
  '%s keeps polling while the durable import is pending', async (operation) => {
    const response = mobileApiContract.endpoints[operation].responseVariants.importPending;
    const api = createApiClient({
      baseUrl: 'https://example.test',
      getAccessToken: async () => 'test-token',
      fetcher: vi.fn(async () => jsonResponse(response)),
    });
    const result = await api[operation]('prediction-importing');
    expect(result).toEqual(response);
    expect(result.status).toBe('processing');
    expect(result.output).toBeNull();
    expect(result.timing).toMatchObject({ appStatus: 'processing' });
  },
);

// An unreadable provider creation receipt uses the existing held-start contract.
it.each(['submissionPending', 'submissionUnconfirmed'] as const)('retains %s for same-key recovery', async (variant) => {
  const pending = mobileApiContract.endpoints.startImageGeneration.errors[variant];
  const api = createApiClient({
    baseUrl: 'https://example.test',
    getAccessToken: async () => 'test-token',
    fetcher: vi.fn(async () => new Response(JSON.stringify(pending.response), {
      status: pending.status, headers: { 'Content-Type': 'application/json' },
    })),
  });
  const error = await api.startImageGeneration({model:'nano-banana-2',prompt:'A ceramic bowl.'}).catch((error:unknown)=>error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({status:409,details:pending.response});
  expect(isAmbiguousGenerationStartFailure(error)).toBe(true);
});


it.each(['updateProfile', 'validateProfile'] as const)('preserves %s invalid-payload errors', async (operation) => {
  const failure = mobileApiContract.profileInvalidPayload;
  expect(failure.operations).toContain(operation);
  const api = createApiClient({
    baseUrl: 'https://magicbooklet.test',
    getAccessToken: async () => 'token-1',
    fetcher: vi.fn(async () => jsonResponse(failure.response, failure.status)) as unknown as typeof fetch,
  });
  await expect(api[operation]({ displayName: 'Creator One' })).rejects.toMatchObject({
    status: failure.status, message: failure.response.error, details: failure.response,
  });
});


it.each(mobileApiContract.socialInputErrors)('preserves $operation input failures as client errors', async (failure) => {
  const operation = [...successCases, ...extendedOperationCases].find(item => item.key === failure.operation);
  expect(operation).toBeDefined();
  const fetcher = vi.fn(async () => jsonResponse(failure.response, failure.status));
  const api = createApiClient({
    baseUrl: 'https://magicbooklet.test', getAccessToken: async () => 'token-1',
    fetcher: fetcher as unknown as typeof fetch,
  });
  await expect(operation!.call(api)).rejects.toMatchObject({
    status: failure.status, message: failure.response.error, details: failure.response,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(mobileApiContract.profileRequestTooLarge.operations)('preserves %s request-size errors', async (name) => {
  const failure = mobileApiContract.profileRequestTooLarge;
  const operation = [...successCases, ...extendedOperationCases].find(item => item.key === name);
  expect(operation).toBeDefined();
  const fetcher = vi.fn(async () => jsonResponse(failure.response, failure.status));
  const api = createApiClient({
    baseUrl: 'https://magicbooklet.test', getAccessToken: async () => 'token-1',
    fetcher: fetcher as unknown as typeof fetch,
  });
  await expect(operation!.call(api)).rejects.toMatchObject({
    status: failure.status, message: failure.response.error, details: failure.response,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
