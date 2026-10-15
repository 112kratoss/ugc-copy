import type { SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { getAppVersionRouteResponse } from '@/lib/app-version-route-adapter-service';
import { getCreditHistoryRouteResponse } from '@/lib/credit-history-route-adapter-service';
import {
  CREDIT_HISTORY_DEFAULT_LIMIT,
  CREDIT_HISTORY_KINDS,
  CREDIT_HISTORY_MAX_LIMIT,
} from '@/lib/credit-history-service';
import {
  MOBILE_CLIENT_COMPATIBILITY_POLICY,
  type MobileCriticalUpdate,
} from '@/lib/mobile-client-compatibility';
import { MobileCommerceError, unlockPostResourceBundleWithCredits } from '@/lib/mobile-commerce';
import { listOwnerPostsForRoute } from '@/lib/owner-post-list-route-service';
import { POST_RESOURCE_FILE_URL_BATCH_LIMIT } from '@/lib/post-resource-bundles';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import { createPostResourceFileReadUrlForRoute } from '@/lib/post-resource-file-url-service';
import { sanitizeProfileRecord } from '@/lib/profile';
import { normalizeShowcaseCategory } from '@/lib/showcase';
import {
  parseShowcaseFeedEventBatchPayload,
  parseShowcaseFeedFeedbackUndoPayload,
  undoShowcaseFeedFeedback,
  type ShowcaseFeedFeedbackUndoResponse,
  type ShowcaseFeedFeedbackUndoTarget,
} from '@/lib/showcase-feed-events-service';
import {
  getShowcaseFeedNewestRouteResponse,
  type ShowcaseFeedNewestResponse,
} from '@/lib/showcase-feed-newest-route-adapter-service';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import mobileApiOperationsV1 from '../../contracts/mobile-api-operations-v1.json';
import type {
  AppVersionResponse,
  MediaReadUrlResponse,
  MediaUploadIntentResponse,
  MobileCommerceSyncResponse,
  MobileCompatibilityErrorResponse,
  MobileNotificationsResponse,
  ProfileResponse,
  PublicSearchResponse,
  ShowcaseFeedEventBatchResponse,
  ShowcaseFeedEventRequest,
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
    appVersion: MobileApiContractEndpoint<AppVersionResponse & { criticalUpdate: MobileCriticalUpdate | null }> & {
      responseVariants: { criticalUpdate: AppVersionResponse & { criticalUpdate: MobileCriticalUpdate } };
    };
    mobileUpdateRequired: MobileApiContractEndpoint<MobileCompatibilityErrorResponse>;
    deleteAccount: MobileApiContractEndpoint<{
      success: boolean;
      deleted: boolean;
      deletionScheduled: boolean;
    }> & {
      request: { confirmation: 'DELETE'; appleAuthorizationCode: string };
      status: 202;
      responseVariants: {
        alreadyDeleted: { success: true; deleted: true; cleanupPending: boolean; alreadyDeleted: true };
      };
      errors: {
        reauthenticationRequired: { status: 403; response: { code: string; reason: 'reauthentication_required'; reauthenticate: true } };
        appleReauthenticationRequired: { status: 403; response: { code: string; reason: 'reauthentication_required'; reauthenticate: true } };
        appleVerificationUnavailable: { status: 503; response: { code: string } };
        accountDeleting: { status: 409; response: { code: 'ACCOUNT_DELETING' } };
        deletionNotStarted: { status: 500; response: { code: string; deletionScheduled: false } };
        deletionRetryScheduled: { status: 500; response: { code: string; deletionScheduled: true } };
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
    recordShowcaseFeedEvents: MobileApiContractEndpoint<ShowcaseFeedEventBatchResponse> & {
      request: { events: Array<ShowcaseFeedEventRequest & { occurredAt: string }> };
    };
    getShowcaseFeedNewest: MobileApiContractEndpoint<ShowcaseFeedNewestResponse> & {
      query: { category: string };
      responseVariants: { emptyLane: ShowcaseFeedNewestResponse };
    };
    undoFeedFeedback: MobileApiContractEndpoint<ShowcaseFeedFeedbackUndoResponse> & {
      request: Extract<ShowcaseFeedFeedbackUndoTarget, { feedbackType: 'not_interested' }>;
      requestVariants: { hideCreator: Extract<ShowcaseFeedFeedbackUndoTarget, { feedbackType: 'hide_creator' }> };
      responseVariants: { nothingToRemove: ShowcaseFeedFeedbackUndoResponse };
    };
    createPostComment: MobileApiContractEndpoint<unknown> & {
      request: { body: string; parentId: string | null; deliveryId: string };
    };
    setCreatorFollowing: MobileApiContractEndpoint<{ following: boolean }> & {
      request: { followingId: string; following: boolean; postId: string; deliveryId: string };
    };
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
  'getShowcaseFeedNewest',
  'recordShowcaseFeedEvents',
  'undoFeedFeedback',
  'searchPublicContent',
  'getSavedMedia',
  'getShowcasePost',
  'listPostComments',
  'createPostComment',
  'deletePostComment',
  'setCreatorFollowing',
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
  'readPostMedia',
  'recordReferralVisit',
  'getCreditHistory',
] as const;

describe('shared mobile API v1 contract fixture', () => {
  it('accepts the media-only Explore category without changing the default feed', () => {
    expect(normalizeShowcaseCategory(mobileApiContract.endpoints.getShowcaseFeed.query.category)).toBe('media');
    expect(normalizeShowcaseCategory(undefined)).toBe('all');
  });
  it('keeps private playback separate from the owner original', () => {
    const video = mobileApiContract.endpoints.listGenerations.response.generations[1];
    // `media` is null for an audio creation, so the list's type allows it here too.
    expect(video.media?.url).toBe(video.output_url);
    expect(video.media?.renditionUrl).toBe('/api/media?bucket=generated_videos&path=owner-1%2Fplayback%2Fprivate-video-1%2Fabc123.mp4');
    expect(video).not.toHaveProperty('playback_rendition_path');
  });

  it('documents bounded preview dimensions in the owner library descriptor', () => {
    expect(mobileApiContract.endpoints.listGenerations.response.generations[0].media)
      .toMatchObject({ width: 720, height: 405 });
  });

  it('documents the display rendition the owner library attaches to an image descriptor', () => {
    // Mobile opens `displayUrl || url`. With the field absent from the shared
    // fixture, a mobile adapter that dropped it passed every contract test.
    expect(mobileApiContract.endpoints.listGenerations.response.generations[0].media)
      .toMatchObject({ kind: 'image', displayUrl: expect.stringMatching(/^https:\/\//) });
  });

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
      && (endpoint.response || endpoint.status === 302)
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
    // A guest reads a post's recipe too; the fixture says what the operations
    // registry says.
    expect(contract.endpoints.getMarketplaceResourceDetail.auth)
      .toBe(mobileApiOperationsV1.operations.getMarketplaceResourceDetail.auth);
    expect(contract.endpoints.getPostResourceBundle.auth).toBe(mobileApiOperationsV1.fallbackRoutes
      .find((route) => route.path === contract.endpoints.getPostResourceBundle.path)?.auth);
    expect(contract.endpoints.getPostResourceBundle.auth).toBe('optional');
    expect(contract.endpoints.deleteAccount).toMatchObject({
      request: {
        confirmation: 'DELETE',
        appleAuthorizationCode: 'fresh-one-time-apple-code',
      },
      // The account is locked and signed out everywhere before the answer; the
      // sweep runs behind it, so the app never reports a timed-out sweep as
      // "still active".
      status: 202,
      response: { success: true, deleted: false, deletionScheduled: true },
      responseVariants: {
        alreadyDeleted: { success: true, deleted: true, alreadyDeleted: true },
      },
      errors: {
        reauthenticationRequired: {
          status: 403,
          response: { code: 'RECENT_AUTH_REQUIRED', reason: 'reauthentication_required', reauthenticate: true },
        },
        appleReauthenticationRequired: {
          status: 403,
          response: { code: 'APPLE_REAUTH_REQUIRED', reason: 'reauthentication_required', reauthenticate: true },
        },
        appleVerificationUnavailable: {
          status: 503,
          response: { code: 'APPLE_REVOCATION_UNAVAILABLE' },
        },
        accountDeleting: { status: 409, response: { code: 'ACCOUNT_DELETING' } },
        deletionNotStarted: { status: 500, response: { code: 'ACCOUNT_DELETION_NOT_STARTED', deletionScheduled: false } },
        deletionRetryScheduled: { status: 500, response: { code: 'ACCOUNT_DELETION_RETRY_SCHEDULED', deletionScheduled: true } },
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

    // The example is the policy the server enforces, not a placeholder: the app
    // and its tests read the floor from here (04-5).
    expect(appVersion.mobileCompatibility).toEqual(MOBILE_CLIENT_COMPATIBILITY_POLICY);
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

  // Your Sales asks for listings only (audit 03-7): the route has to take the
  // query the fixture documents and answer with listings and the seller totals.
  it('serves Your Sales the listings-only owner list the fixture documents', async () => {
    const endpoint = mobileApiContract.endpoints.listOwnerPosts;
    const loadOwnerPosts = vi.fn(async () => endpoint.response.posts);
    const loadOwnerPostSalesSummary = vi.fn(async () => endpoint.response.summary);

    const result = await listOwnerPostsForRoute({
      userId: 'user-1',
      searchParams: new URLSearchParams(endpoint.query),
      loadOwnerPosts,
      loadOwnerPostSalesSummary,
    });

    expect(loadOwnerPosts).toHaveBeenCalledWith('user-1', expect.objectContaining({ listingsOnly: true }));
    expect(loadOwnerPostSalesSummary).toHaveBeenCalledWith('user-1');
    expect(result).toMatchObject({ ok: true, posts: endpoint.response.posts, summary: endpoint.response.summary });
    // The state a listing row is drawn from: moderation, the listing check,
    // retirement, and a post deleted while it had buyers.
    expect(endpoint.response.posts[0]).toMatchObject({
      tombstonedAt: null,
      bundle: { reviewStatus: 'visible', quality: { eligible: true, message: null }, retiredAt: null },
    });
  });

  // The critical-update lever (04-9) rides on the same answer: null until the
  // deployment sets both variables, then the runtimes and instant they name.
  it('answers /api/app-version in the shapes the fixture pins', async () => {
    const endpoint = contract.endpoints.appVersion;
    const answer = async (environment: Record<string, string>) => {
      const response = await getAppVersionRouteResponse({
        request: new Request(`http://localhost${endpoint.path}`),
        environment: { VERCEL_GIT_COMMIT_SHA: 'build-123', ...environment },
      });
      expect(response.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
      return response.json();
    };

    await expect(answer({})).resolves.toEqual(endpoint.response);
    const { criticalUpdate } = endpoint.responseVariants.criticalUpdate;
    await expect(answer({
      MOBILE_CRITICAL_UPDATE_RUNTIME: criticalUpdate.runtimeVersions.join(','),
      MOBILE_CRITICAL_UPDATE_AFTER: criticalUpdate.publishedAfter,
    })).resolves.toEqual(endpoint.responseVariants.criticalUpdate);
  });

  // Feed ranking v4 (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md
  // §4): a comment or a follow started from a ranked card names the delivery
  // that showed it, and a follow the post it was pressed on. Both are optional:
  // a client that sends neither is answered exactly as before.
  it('pins the delivery a comment or a follow from a feed card carries', () => {
    expect(contract.endpoints.createPostComment).toMatchObject({
      method: 'POST',
      path: '/api/showcase/posts/:postId/comments',
      request: { body: 'Saving this for later.', parentId: null, deliveryId: '9001' },
    });
    expect(contract.endpoints.setCreatorFollowing).toMatchObject({
      method: 'POST',
      path: '/api/profile/follow',
      auth: 'required',
      request: {
        followingId: 'creator-1',
        following: true,
        postId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        deliveryId: '9001',
      },
      response: { following: true },
    });
  });

  // The attention the Home feed now reports (dwell, inline video progress, a
  // card's resources opened) travels in the batch the app's queue sends. No new
  // event type: the server takes every one of them as the app writes it.
  it('accepts every feed event the app batches from the Home feed', () => {
    const { events } = contract.endpoints.recordShowcaseFeedEvents.request;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(events[0].occurredAt) + 60_000));
    try {
      const parsed = parseShowcaseFeedEventBatchPayload(contract.endpoints.recordShowcaseFeedEvents.request);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.batched).toBe(true);
      expect(parsed.payloads.map((payload) => [payload.eventType, payload.deliveryId, payload.durationMs, payload.progress]))
        .toEqual([
          ['dwell', '9001', 4200, null],
          ['media_progress', '9001', 95500, 0.5],
          ['resource_open', '9001', null, null],
        ]);
    } finally {
      vi.useRealTimers();
    }
    const batch: ShowcaseFeedEventBatchResponse = contract.endpoints.recordShowcaseFeedEvents.response;
    expect(batch).toEqual({
      success: true,
      recorded: events.length,
      rejected: 0,
      // One outcome per event sent, in request order (04-11).
      results: events.map((_event, index) => ({ index, status: 200 })),
    });
  });

  // Undo (product decision D7) takes back a Not interested or a Hide. The
  // bodies the clients send are the ones the server's parser reads, and the
  // answers are the service's, for a row that was there and for none.
  it('takes back a Not interested or a Hide in the shapes the fixture pins', async () => {
    const endpoint = contract.endpoints.undoFeedFeedback;
    expect(endpoint).toMatchObject({
      method: 'POST',
      path: '/api/showcase/feed/feedback/undo',
      auth: 'required',
    });
    expect(parseShowcaseFeedFeedbackUndoPayload(endpoint.request)).toEqual({ ok: true, target: endpoint.request });
    expect(parseShowcaseFeedFeedbackUndoPayload(endpoint.requestVariants.hideCreator))
      .toEqual({ ok: true, target: endpoint.requestVariants.hideCreator });

    const deleting = (deletedRows: Array<Record<string, string>>) => {
      const query = {
        delete: () => query,
        eq: () => query,
        is: () => query,
        select: async () => ({ data: deletedRows, error: null }),
      };
      return { from: () => query } as unknown as SupabaseClient;
    };
    await expect(undoShowcaseFeedFeedback({
      actorUserId: 'viewer-1',
      serviceClient: deleting([{ post_id: endpoint.request.postId }]),
      target: endpoint.request,
    })).resolves.toEqual({ ok: true, body: endpoint.response });
    await expect(undoShowcaseFeedFeedback({
      actorUserId: 'viewer-1',
      serviceClient: deleting([]),
      target: endpoint.requestVariants.hideCreator,
    })).resolves.toEqual({ ok: true, body: endpoint.responseVariants.nothingToRemove });
  });

  // The probe behind the "New posts" pill (D2): the query a lane sends, and
  // the answer and cache policy the route serves from the row it reads.
  it('answers the newest-post probe in the shape and cache policy the fixture pins', async () => {
    const endpoint = contract.endpoints.getShowcaseFeedNewest;
    expect(normalizeShowcaseCategory(endpoint.query.category)).toBe('media');
    const probe = async (row: { id: string; created_at: string } | null) => {
      const query = {
        select: () => query,
        eq: () => query,
        is: () => query,
        neq: () => query,
        or: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      const response = await getShowcaseFeedNewestRouteResponse({
        request: new Request(`http://localhost${endpoint.path}?${new URLSearchParams(endpoint.query)}`),
        dependencies: {
          createServiceClient: vi.fn(() => ({ from: () => query }) as unknown as SupabaseClient),
          enforceBackendRateLimit: vi.fn(async () => ({
            allowed: true,
            limit: 240,
            remaining: 239,
            retryAfterSeconds: 0,
            resetAt: '2026-10-14T05:40:00.000Z',
          })),
          getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
      return response.json();
    };

    await expect(probe({ id: String(endpoint.response.newestPostId), created_at: '2026-10-14T05:30:00+00:00' }))
      .resolves.toEqual(endpoint.response);
    await expect(probe(null)).resolves.toEqual(endpoint.responseVariants.emptyLane);
  });

  // A bundle's files signed in one call: the request and the answer the app
  // codes against, held to what the server's own service returns for them.
  it('answers the file-url batch request with the files the fixture pins', async () => {
    const endpoint = mobileApiContract.endpoints.getPostResourceFileUrl;
    const request = endpoint.requestVariants.batch;
    expect(endpoint.batchLimit).toBe(POST_RESOURCE_FILE_URL_BATCH_LIMIT);
    // The single-path answer is unchanged.
    expect(endpoint.response).toEqual({ success: true, signedUrl: expect.any(String) });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-22T06:00:00.000Z'));
    try {
      const result = await createPostResourceFileReadUrlForRoute({
        body: request,
        client: {
          rpc: vi.fn(async () => ({
            data: { allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-06-22T06:10:00.000Z' },
            error: null,
          })),
          storage: {
            from: (bucket: string) => ({
              createSignedUrl: async (path: string) => ({
                data: { signedUrl: `https://storage.example.test/signed/${bucket}/${path}` },
                error: null,
              }),
            }),
          },
        },
        countryCode: null,
        getDetailByPostId: vi.fn(async () => ({
          viewerCanAccess: true,
          seller: { id: 'user-1' },
          resources: {
            attachments: [],
            items: request.storagePaths.map((storagePath) => ({ title: 'Reference', storagePath })),
          },
        }) as unknown as PostResourceBundleDetail),
        postId: 'post-1',
        rateLimitKey: 'buyer-1',
        viewerUserId: 'buyer-1',
      });
      expect(result).toEqual({ ok: true, body: endpoint.responseVariants.batch });
    } finally {
      vi.useRealTimers();
    }
  });

  // Welcome and referral credits count in the balance but cannot buy a recipe.
  // The profile read says how much can, by the rule the unlock RPC applies.
  it('answers the profile read with the spendable part of the balance', () => {
    const profile: ProfileResponse = mobileApiContract.endpoints.getProfile.response;
    expect(profile.marketplaceSpendableCredits).toBeLessThan(profile.credits ?? 0);
    expect(sanitizeProfileRecord({
      id: profile.id,
      username: profile.username,
      display_name: profile.displayName,
      bio: profile.bio,
      avatar_url: profile.avatarUrl,
      cover_url: profile.coverUrl,
      website_url: profile.websiteUrl,
      twitter_handle: profile.twitterHandle,
      instagram_handle: profile.instagramHandle,
      tiktok_handle: profile.tiktokHandle,
      location: profile.location,
      credits: profile.credits,
      promotional_credits: profile.promotionalCredits,
    })).toMatchObject({
      credits: profile.credits,
      promotionalCredits: profile.promotionalCredits,
      marketplaceSpendableCredits: profile.marketplaceSpendableCredits,
    });
  });

  // Both answers of a credit unlock say what stays spendable, and the refusal
  // carries the code the clients offer credits on: the answers the service
  // builds, field for field.
  it('answers a credit unlock and its refusal with the spendable figure the fixture pins', async () => {
    const endpoint = mobileApiContract.endpoints.unlockBundleWithCredits;
    const refused = endpoint.errors.insufficientCredits;
    const unlockWith = (data: Record<string, unknown>) => unlockPostResourceBundleWithCredits({
      adminSupabase: { rpc: vi.fn(async () => ({ data, error: null })) } as unknown as SupabaseClient,
      userId: 'buyer-1',
      postId: endpoint.response.postId,
      invalidateMarketplaceResourceListCache: vi.fn(),
      notifyPostResourceUnlockCompleted: vi.fn(async () => null),
      recordPurchaseFeedEvent: vi.fn(async () => ({ status: 'recorded' as const, deliveryId: null })),
    });

    await expect(unlockWith({
      status: 'completed',
      remaining_credits: endpoint.response.credits,
      marketplace_spendable_credits: endpoint.response.marketplaceSpendableCredits,
      post_id: endpoint.response.postId,
      bundle_id: 'bundle-1',
      owner_user_id: 'creator-1',
      credit_cost: 54,
    })).resolves.toMatchObject({
      entitlement: endpoint.response.entitlement,
      postId: endpoint.response.postId,
      credits: endpoint.response.credits,
      marketplaceSpendableCredits: endpoint.response.marketplaceSpendableCredits,
      alreadyProcessed: endpoint.response.alreadyProcessed,
    });

    const refusal = await unlockWith({
      status: 'insufficient_credits',
      remaining_credits: refused.response.remainingCredits,
      marketplace_spendable_credits: refused.response.marketplaceSpendableCredits,
      credit_cost: refused.response.creditCost,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MobileCommerceError);
    const { status, message, details } = refusal as MobileCommerceError;
    expect(status).toBe(refused.status);
    expect({ error: message, ...details }).toEqual(refused.response);
  });
});

 it('keeps uploaded-media redirects optional-auth and uncacheable', () => {
  expect(mobileApiContract.endpoints.readPostMedia).toMatchObject({
    path: '/api/media', auth: 'optional', status: 302, cacheControl: 'private, no-store',
  });
});

// Credit history (contract C4 of the 2026-10-15 decisions run): the route turns
// the database's rows into the fixture's page, cursor included, and answers its
// two refusals in the fixture's words.
describe('credit history contract', () => {
  const endpoint = mobileApiContract.endpoints.getCreditHistory;

  function creditHistoryRoute(rows: unknown[]) {
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const answer = (query: string) => getCreditHistoryRouteResponse({
      request: new Request(`http://localhost${endpoint.path}?${query}`),
      dependencies: {
        createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => ({}) as unknown as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-10-15T10:00:00.000Z',
        })),
        requireIdentity: vi.fn(async () => ({
          ok: true as const,
          identity: { user: { id: 'account-1' } as User, userId: 'account-1', kind: 'registered' as const, isGuest: false },
        })),
        resolveLinkedAccountIds: vi.fn(async () => ['account-1', 'guest-1']),
      },
    });
    return { rpc, answer };
  }

  it('answers a page in the shape the fixture pins', async () => {
    const { entries } = endpoint.response;
    // The rows behind the page carry the database's microseconds; the last one's
    // are the ones the fixture's cursor holds. One more row says a page follows.
    const rows = entries.map((entry, index) => ({
      entry_id: entry.id,
      kind: entry.kind,
      amount: entry.amount,
      occurred_at: index === entries.length - 1
        ? '2026-10-10T08:00:00.123456+00:00'
        : entry.occurredAt.replace('Z', '987+00:00'),
      title: entry.title,
      detail: entry.detail,
    }));
    rows.push({
      entry_id: 'purchase:3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d',
      kind: 'purchase',
      amount: 500,
      occurred_at: '2026-10-01T08:00:00+00:00',
      title: 'Starter pack',
      detail: 'Bought on the web',
    });
    const { rpc, answer } = creditHistoryRoute(rows);

    const response = await answer(new URLSearchParams(endpoint.query).toString());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
    await expect(response.json()).resolves.toEqual(endpoint.response);
    expect(rpc).toHaveBeenCalledWith('list_credit_history', {
      p_user_ids: ['account-1', 'guest-1'],
      p_before_occurred_at: null,
      p_before_id: null,
      p_limit: Number(endpoint.query.limit) + 1,
    });
    expect(endpoint.kinds).toEqual([...CREDIT_HISTORY_KINDS]);
    expect(endpoint.paging.limit).toEqual({
      default: CREDIT_HISTORY_DEFAULT_LIMIT,
      minimum: 1,
      maximum: CREDIT_HISTORY_MAX_LIMIT,
    });
  });

  it('reads the next page from the fixture cursor and ends on an empty one', async () => {
    const { rpc, answer } = creditHistoryRoute([]);

    const response = await answer(`cursor=${endpoint.response.nextCursor}`);

    await expect(response.json()).resolves.toEqual(endpoint.responseVariants.lastPage);
    expect(rpc).toHaveBeenCalledWith('list_credit_history', expect.objectContaining({
      p_before_occurred_at: '2026-10-10T08:00:00.123456+00:00',
      p_before_id: endpoint.response.entries.at(-1)?.id,
    }));
  });

  it('refuses a cursor it did not write and a limit that is not a number, in the fixture words', async () => {
    const { rpc, answer } = creditHistoryRoute([]);

    const badCursor = await answer('cursor=not-a-cursor');
    expect(badCursor.status).toBe(endpoint.errors.invalidCursor.status);
    await expect(badCursor.json()).resolves.toEqual(endpoint.errors.invalidCursor.response);

    const badLimit = await answer('limit=ten');
    expect(badLimit.status).toBe(endpoint.errors.invalidLimit.status);
    await expect(badLimit.json()).resolves.toEqual(endpoint.errors.invalidLimit.response);

    expect(rpc).not.toHaveBeenCalled();
  });
});
