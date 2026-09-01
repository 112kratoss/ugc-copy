import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';
import type {
  AppVersionResponse,
  MediaReadUrlResponse,
  MediaUploadIntentResponse,
  MobileCommerceSyncResponse,
  MobileCompatibilityErrorResponse,
  MobileNotificationsResponse,
  PublicSearchResponse,
} from '../../ugc-mobile/lib/types';

type MobileApiContractEndpoint<Response> = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  auth: 'required' | 'optional' | 'none';
  cacheControl: string;
  status?: number;
  response: Response;
};

type MobileApiContractFixture = {
  schemaVersion: 1;
  endpoints: Record<string, MobileApiContractEndpoint<unknown>> & {
    appVersion: MobileApiContractEndpoint<AppVersionResponse>;
    mobileUpdateRequired: MobileApiContractEndpoint<MobileCompatibilityErrorResponse>;
    deleteAccount: MobileApiContractEndpoint<{
      success: boolean;
      deleted: boolean;
      cleanupPending: boolean;
    }> & {
      request: { confirmation: 'DELETE'; appleAuthorizationCode: string };
      errors: {
        appleReauthenticationRequired: { status: 403; response: { code: string; reauthenticate: true } };
        appleVerificationUnavailable: { status: 503; response: { code: string } };
      };
    };
    mediaUploadIntent: MobileApiContractEndpoint<MediaUploadIntentResponse>;
    mediaReadUrl: MobileApiContractEndpoint<MediaReadUrlResponse>;
    mobileCommerceSync: MobileApiContractEndpoint<MobileCommerceSyncResponse>;
    mobileCommerceRestore: MobileApiContractEndpoint<{
      success: boolean;
      entitlements: MobileCommerceSyncResponse[];
    }>;
    mobileNotifications: MobileApiContractEndpoint<MobileNotificationsResponse>;
    searchPublicContent: MobileApiContractEndpoint<PublicSearchResponse>;
  };
};

const contract = mobileApiContract as MobileApiContractFixture;

const expectedEndpointKeys = [
  'appVersion',
  'mobileUpdateRequired',
  'getProfile',
  'updateProfile',
  'deleteAccount',
  'listGenerations',
  'archiveGeneration',
  'restoreGeneration',
  'startImageGeneration',
  'getImageGeneration',
  'startVideoGeneration',
  'getVideoGeneration',
  'startMotionGeneration',
  'getMotionGeneration',
  'enhancePrompt',
  'getShowcaseFeed',
  'searchPublicContent',
  'getSavedMedia',
  'getShowcasePost',
  'listPostComments',
  'createPostComment',
  'deletePostComment',
  'saveShowcasePost',
  'remixShowcasePost',
  'shareShowcasePost',
  'shareCreatorProfile',
  'publishGeneration',
  'createPost',
  'listSourceTools',
  'listGenerationModels',
  'quoteGenerationModel',
  'signPostResourceFileUpload',
  'finalizePostResourceFileUpload',
  'mediaUploadIntent',
  'finalizeUpload',
  'mediaReadUrl',
  'createProfileMediaUpload',
  'listPosts',
  'listOwnerPosts',
  'getOwnerPost',
  'updatePost',
  'archivePost',
  'restorePost',
  'deletePost',
  'listMarketplaceResources',
  'getMarketplaceResourceDetail',
  'getPostResourceBundle',
  'unlockFreeBundle',
  'unlockBundleWithCredits',
  'getPostResourceFileUrl',
  'mobileCommerceSync',
  'mobileCommerceRestore',
  'registerMobilePushToken',
  'unregisterMobilePushToken',
  'mobileNotifications',
  'markMobileNotificationsRead',
  'markAllMobileNotificationsRead',
  'getMobileNotificationPreferences',
  'updateMobileNotificationPreferences',
] as const;

describe('shared mobile API v1 contract fixture', () => {
  it('keeps response fixtures inside the exhaustive mobile operation registry', () => {
    const registeredPaths = new Set([
      ...Object.values(mobileApiOperationsV1.operations).map((operation) => operation.path),
      ...mobileApiOperationsV1.fallbackRoutes.map((operation) => operation.path),
    ]);
    expect(mobileApiOperationsV1.schemaVersion).toBe(contract.schemaVersion);
    expect(Object.values(contract.endpoints).every((endpoint) => registeredPaths.has(endpoint.path))).toBe(true);
    expect(Object.values(mobileApiOperationsV1.operations).every((operation) => (
      operation.path.startsWith('/api/')
      && ['GET', 'POST', 'PATCH', 'DELETE'].includes(operation.method)
      && ['required', 'optional', 'none'].includes(operation.auth)
    ))).toBe(true);
  });

  it('documents the core mobile backend endpoints and cache boundaries', () => {
    expect(contract.schemaVersion).toBe(1);
    expect(Object.keys(contract.endpoints)).toEqual(expectedEndpointKeys);
    expect(Object.values(contract.endpoints).every((endpoint) => Boolean(
      endpoint.method
      && endpoint.path.startsWith('/api/')
      && endpoint.cacheControl
      && endpoint.response
    ))).toBe(true);
    expect(contract.endpoints.appVersion).toMatchObject({
      method: 'GET',
      path: '/api/app-version',
      auth: 'none',
      cacheControl: 'no-store, no-cache, must-revalidate',
    });
    expect(contract.endpoints.listGenerationModels).toMatchObject({
      method: 'GET',
      path: '/api/generation-models',
      auth: 'none',
      cacheControl: 'public, max-age=300, stale-while-revalidate=300',
    });
    expect(contract.endpoints.getMarketplaceResourceDetail.path).toBe('/api/marketplace/resources/:resourceId');
    expect(contract.endpoints.getPostResourceBundle.path).toBe('/api/posts/:postId/resource-bundle');
    expect(contract.endpoints.deleteAccount).toMatchObject({
      request: {
        confirmation: 'DELETE',
        appleAuthorizationCode: 'fresh-one-time-apple-code',
      },
      errors: {
        appleReauthenticationRequired: {
          status: 403,
          response: { code: 'APPLE_REAUTH_REQUIRED', reauthenticate: true },
        },
        appleVerificationUnavailable: {
          status: 503,
          response: { code: 'APPLE_REVOCATION_UNAVAILABLE' },
        },
      },
    });
    expect(Object.entries(contract.endpoints)
      .filter(([, endpoint]) => endpoint.method !== 'GET')
      .every(([, endpoint]) => endpoint.cacheControl === 'private, no-store')).toBe(true);
  });

  it('keeps shared response examples compatible with mobile app types', () => {
    const appVersion: AppVersionResponse = contract.endpoints.appVersion.response;
    const updateRequired: MobileCompatibilityErrorResponse = contract.endpoints.mobileUpdateRequired.response;
    const uploadIntent: MediaUploadIntentResponse = contract.endpoints.mediaUploadIntent.response;
    const readUrl: MediaReadUrlResponse = contract.endpoints.mediaReadUrl.response;
    const commerceSync: MobileCommerceSyncResponse = contract.endpoints.mobileCommerceSync.response;
    const notifications: MobileNotificationsResponse = contract.endpoints.mobileNotifications.response;

    expect(appVersion.mobileCompatibility).toMatchObject({
      currentApiVersion: 1,
      minimumAppVersion: '0.0.1',
    });
    expect(updateRequired).toMatchObject({
      code: 'MOBILE_UPDATE_REQUIRED',
      compatibility: appVersion.mobileCompatibility,
    });
    expect(uploadIntent).toMatchObject({
      success: true,
      bucket: 'uploads',
      expiresInSeconds: 7200,
    });
    expect(readUrl).toEqual({
      success: true,
      signedUrl: 'https://storage.example.test/signed/reference.png',
      expiresInSeconds: 3600,
    });
    expect(commerceSync).toEqual({
      success: true,
      entitlement: 'credits',
      credits: 120,
    });
    expect(notifications.notifications[0]).toMatchObject({
      id: 'notification-1',
      type: 'credits_purchased',
      category: 'commerce',
      isRead: false,
    });
  });
});
