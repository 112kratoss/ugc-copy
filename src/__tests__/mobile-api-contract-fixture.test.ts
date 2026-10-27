import type { SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { getAppVersionRouteResponse } from '@/lib/app-version-route-adapter-service';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { getCreditHistoryRouteResponse } from '@/lib/credit-history-route-adapter-service';
import { postResourceBundleCreditUnlockRouteResponse } from '@/lib/credit-unlock-route-adapter-service';
import type { HomeShelfAction, HomeShelfBadge, HomeShelfCreation, HomeShelfPrice } from '@/lib/home-shelf';
import { formatHomeShelfPrice, homeShelfActionCopy, homeShelfBadge } from '@/lib/home-shelf-copy';
import {
  getHomeShelfRouteResponse,
  type HomeShelfRouteResponse,
} from '@/lib/home-shelf-route-adapter-service';
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
import { getProfileRouteResult } from '@/lib/profile-route-adapter-service';
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
import type { findPublicPostReferenceByIdOrGenerationId } from '@/lib/posts-server';
import { getShowcasePostResolveRouteResponse } from '@/lib/showcase-post-resolve-route-adapter-service';
import { postSaverNoticeRouteResponse } from '@/lib/saver-notice-route-adapter-service';
import { postShowcaseSaveRouteResponse } from '@/lib/showcase-save-route-adapter-service';
import type { ShowcaseSaveResponseBody } from '@/lib/showcase-save-service';
import {
  parseShowcaseSharePayloadForRoute,
  shareShowcasePostForRoute,
} from '@/lib/showcase-share-service';
import { mapGenerationStartRouteError } from '@/lib/unified-generation-route-service';
import { startUnifiedGenerationForRoute } from '@/lib/unified-generation-start-service';

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
        guestLinked: { status: 409; response: { code: 'SESSION_MERGED' } };
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
    getHomeShelf: MobileApiContractEndpoint<HomeShelfRouteResponse> & {
      responseVariants: Record<'member' | 'memberWhoPosted', {
        cacheControl: string;
        response: HomeShelfRouteResponse;
      }>;
      copy: {
        actions: Record<HomeShelfAction['id'], { title: string; body: string; cta: string }>;
        prices: Array<{ price: HomeShelfPrice; label: string }>;
        badges: Array<{ badge: HomeShelfBadge | null; fitsWelcomeCredits: boolean; offerFreeToTry: boolean; label: string | null }>;
        referralPercents: Array<{ inviterPercent: number; inviteePercent: number; body: string }>;
      };
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
  'resolveShowcasePost',
  'listPostComments',
  'createPostComment',
  'deletePostComment',
  'setCreatorFollowing',
  'saveShowcasePost',
  'recordSaverNotice',
  'remixShowcasePost',
  'shareShowcasePost',
  'recordShareVisit',
  'shareCreatorProfile',
  'publishGeneration',
  'createPost',
  'listSourceTools',
  'listGenerationModels',
  'quoteGenerationModel',
  'startGeneration',
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
  'getHomeShelf',
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
        // D5: a guest deletes itself with its own token; one already linked to
        // an account is refused as identity admission refuses its session.
        guestLinked: {
          status: 409,
          response: {
            error: 'This guest session has been linked to an account. Sign in to continue.',
            code: 'SESSION_MERGED',
          },
        },
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

  // The shelf answers a visitor with no token the creations alone, shared at the
  // edge, and a member their own offers too, never shared. A guest's token is
  // read for what it is: the creations alone, as a signed-out visitor gets them,
  // less what that guest took out of the feed, so its answer is never shared either.
  it('answers the home shelf in the shapes and cache policy the fixture pins', async () => {
    const endpoint = contract.endpoints.getHomeShelf;
    const answer = async (
      authorization: string | null,
      items: HomeShelfRouteResponse['items'],
      user: Pick<User, 'id' | 'is_anonymous'> | null,
    ) => {
      const loadHomeShelfForApi = vi.fn(async () => items);
      const response = await getHomeShelfRouteResponse({
        request: new Request(`http://localhost${endpoint.path}`, {
          headers: authorization ? { Authorization: authorization } : {},
        }),
        dependencies: {
          createServiceClient: vi.fn(() => ({}) as unknown as SupabaseClient),
          createUserClient: vi.fn(() => ({
            auth: { getUser: async () => ({ data: { user }, error: null }) },
          }) as unknown as SupabaseClient),
          enforceBackendRateLimit: vi.fn(async () => ({
            allowed: true,
            limit: 120,
            remaining: 119,
            retryAfterSeconds: 0,
            resetAt: '2026-10-25T06:10:00.000Z',
          })),
          getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
          loadHomeShelfForApi,
        },
      });
      expect(response.status).toBe(200);
      return { response, loadHomeShelfForApi };
    };

    const signedOut = await answer(null, endpoint.response.items, null);
    expect(signedOut.response.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
    await expect(signedOut.response.json()).resolves.toEqual(endpoint.response);
    expect(signedOut.loadHomeShelfForApi).toHaveBeenCalledWith({ viewerUserId: null, isAnonymous: false });

    for (const variant of ['member', 'memberWhoPosted'] as const) {
      const fixture = endpoint.responseVariants[variant];
      const member = await answer('Bearer token-1', fixture.response.items, { id: 'user-2', is_anonymous: false });
      expect(member.response.headers.get('Cache-Control')).toBe(fixture.cacheControl);
      await expect(member.response.json()).resolves.toEqual(fixture.response);
      expect(member.loadHomeShelfForApi).toHaveBeenCalledWith({ viewerUserId: 'user-2', isAnonymous: false });
    }

    const guest = await answer('Bearer guest-token', endpoint.response.items, { id: 'guest-1', is_anonymous: true });
    expect(guest.loadHomeShelfForApi).toHaveBeenCalledWith({ viewerUserId: 'guest-1', isAnonymous: true });
    expect(guest.response.headers.get('Cache-Control')).toBe(endpoint.responseVariants.member.cacheControl);
    await expect(guest.response.json()).resolves.toEqual(endpoint.response);
  });

  // The app says the same words from its own copy (ugc-mobile's
  // home-shelf-view-model.test.ts holds it to this fixture too).
  it('words the shelf as the fixture pins', () => {
    const { copy, responseVariants } = contract.endpoints.getHomeShelf;
    const actions = [...responseVariants.member.response.items, ...responseVariants.memberWhoPosted.response.items]
      .filter((item): item is HomeShelfAction => item.kind === 'action');

    expect(new Set(actions.map((action) => action.id))).toEqual(new Set(['post', 'invite', 'earn']));
    for (const action of actions) {
      const { title, body, cta } = homeShelfActionCopy(action);
      expect({ title, body, cta }).toEqual(copy.actions[action.id]);
    }
    for (const { price, label } of copy.prices) {
      expect(formatHomeShelfPrice(price)).toBe(label);
    }
    const creation: HomeShelfCreation = responseVariants.member.response.items.find((item) => item.kind === 'creation') as HomeShelfCreation;
    for (const { badge, fitsWelcomeCredits, offerFreeToTry, label } of copy.badges) {
      expect(homeShelfBadge({ ...creation, badge, fitsWelcomeCredits }, offerFreeToTry)).toBe(label);
    }
    for (const { inviterPercent, inviteePercent, body } of copy.referralPercents) {
      expect(homeShelfActionCopy({ kind: 'action', id: 'invite', inviterPercent, inviteePercent }).body).toBe(body);
    }
  });

  // A save names its saver only when the app says it told them first: the field
  // the app sends is the one the route reads, and anything else stays unnamed.
  it('reads the save request the fixture pins, naming the saver only for its flag', async () => {
    const endpoint = mobileApiContract.endpoints.saveShowcasePost;
    const saveShowcasePostForRoute = vi.fn(async () => ({
      ok: true as const,
      body: endpoint.response as ShowcaseSaveResponseBody,
    }));
    const post = (body: unknown) => postShowcaseSaveRouteResponse({
      request: new Request('http://localhost/api/showcase/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })) },
        }) as unknown as SupabaseClient,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-10-19T10:00:00.000Z',
        })),
        runAfterResponse: vi.fn(),
        saveShowcasePostForRoute,
      },
    });

    const response = await post(endpoint.request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(endpoint.response);
    expect(saveShowcasePostForRoute).toHaveBeenLastCalledWith(expect.objectContaining({
      actorUserId: 'viewer-1',
      referenceId: endpoint.request.postId,
      requestedSaveState: endpoint.request.shouldSave,
      creatorSeesSaver: true,
    }));

    await post({ postId: endpoint.request.postId, shouldSave: endpoint.request.shouldSave });
    expect(saveShowcasePostForRoute).toHaveBeenLastCalledWith(expect.objectContaining({
      creatorSeesSaver: false,
      saverNotYetTold: false,
    }));

    // A save made while its saver is being told: the creator hears nothing of it.
    await post(endpoint.requestVariants.notYetTold);
    expect(saveShowcasePostForRoute).toHaveBeenLastCalledWith(expect.objectContaining({
      creatorSeesSaver: false,
      saverNotYetTold: true,
    }));
  });

  // The record is read with the profile (`saverNoticeSeen`); the route only writes it.
  it('records that the account was told, as the fixture pins', async () => {
    const dependencies = {
      createServiceClient: vi.fn(() => ({}) as SupabaseClient),
      createUserClient: () => ({
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })) },
      }) as unknown as SupabaseClient,
      enforceBackendRateLimit: vi.fn(async () => ({
        allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0, resetAt: '2026-10-19T10:00:00.000Z',
      })),
      recordSaverNoticeSeen: vi.fn(async () => true),
    };
    const request = new Request('http://localhost/api/profile/saver-notice', { method: 'POST' });

    const recorded = await postSaverNoticeRouteResponse({ request, dependencies });
    expect(recorded.status).toBe(200);
    expect(recorded.headers.get('Cache-Control')).toBe(mobileApiContract.endpoints.recordSaverNotice.cacheControl);
    await expect(recorded.json()).resolves.toEqual(mobileApiContract.endpoints.recordSaverNotice.response);
    expect(dependencies.recordSaverNoticeSeen).toHaveBeenCalledWith(expect.anything(), 'viewer-1');
    expect(mobileApiContract.endpoints).not.toHaveProperty('getSaverNotice');
  });

  // C14 (product decision 14): the app reports a shared link it opened on the
  // share route, with the link's surface and no channel.
  it('records a share visit from the request the fixture pins, and refuses in its words', async () => {
    const endpoint = mobileApiContract.endpoints.recordShareVisit;
    const parsed = parseShowcaseSharePayloadForRoute(endpoint.request);
    expect(parsed).toEqual({
      ok: true,
      payload: { eventType: 'share_visit', referenceId: endpoint.request.postId, sourceSurface: endpoint.request.sourceSurface },
    });
    expect(parseShowcaseSharePayloadForRoute(endpoint.requestVariants.unknownSurface)).toMatchObject({
      ok: true,
      payload: { eventType: 'share_visit', sourceSurface: 'detail-page' },
    });
    expect(parseShowcaseSharePayloadForRoute({ postId: endpoint.request.postId, eventType: 'share_visit' })).toEqual({
      ok: false,
      status: endpoint.errors.missingSurface.status,
      body: endpoint.errors.missingSurface.response,
    });
    if (!parsed.ok) throw new Error('Expected the fixture request to parse');

    const share = (post: Awaited<ReturnType<typeof findPublicPostReferenceByIdOrGenerationId>>) => shareShowcasePostForRoute({
      ...parsed.payload,
      actorUserId: 'viewer-1',
      serviceClient: {} as SupabaseClient,
      dependencies: {
        findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => post),
        isUserRelationshipBlocked: vi.fn(async () => false),
        notifyPostSocialActivity: vi.fn(async () => null),
        recordPostShareEvent: vi.fn(async () => undefined),
      },
    });
    await expect(share({
      id: endpoint.request.postId,
      user_id: 'creator-1',
      generation_id: null,
      visibility: 'public',
      category: 'image',
      prompt: null,
      source_kind: 'magicbooklet',
    })).resolves.toEqual({ ok: true, body: endpoint.response });
    await expect(share(null)).resolves.toEqual({
      ok: false,
      status: endpoint.errors.notPublic.status,
      body: endpoint.errors.notPublic.response,
    });
  });

  // C15 (product decision 15): which live post an id names, an old link's
  // generation id included.
  it('answers the post resolver in the shapes and cache policy the fixture pins', async () => {
    const endpoint = mobileApiContract.endpoints.resolveShowcasePost;
    const resolve = (id: string) => getShowcasePostResolveRouteResponse({
      request: new Request(`http://localhost${endpoint.path.replace(':postId', id)}`),
      context: { params: Promise.resolve({ postId: id }) },
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 300,
          remaining: 299,
          retryAfterSeconds: 0,
          resetAt: '2026-10-17T15:00:00.000Z',
        })),
        getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
        getPostReferenceForShowcaseId: vi.fn(async (postId: string) => (
          postId === endpoint.pathParams.postId
            ? {
              id: endpoint.response.postId,
              user_id: 'creator-1',
              generation_id: endpoint.pathParams.postId,
              visibility: 'public' as const,
              category: 'image' as const,
              prompt: null,
              source_kind: 'magicbooklet' as const,
            }
            : null
        )),
      },
    });

    const found = await resolve(endpoint.pathParams.postId);
    expect(found.status).toBe(200);
    expect(found.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
    await expect(found.json()).resolves.toEqual(endpoint.response);

    const missing = await resolve('nothing-1');
    expect(missing.status).toBe(endpoint.errors.notFound.status);
    await expect(missing.json()).resolves.toEqual(endpoint.errors.notFound.response);
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

  // The app starts its saver notice from the profile it loads at launch, so
  // the read carries the account's record and the app never asks on its own.
  it("answers the profile read with the account's saver notice record, as the fixture pins", async () => {
    const endpoint = mobileApiContract.endpoints.getProfile;
    const pinned = endpoint.response;
    const storedRow = (saverNoticeSeenAt: string | null) => ({
      id: pinned.id,
      username: pinned.username,
      display_name: pinned.displayName,
      bio: pinned.bio,
      avatar_url: pinned.avatarUrl,
      cover_url: pinned.coverUrl,
      website_url: pinned.websiteUrl,
      twitter_handle: pinned.twitterHandle,
      instagram_handle: pinned.instagramHandle,
      tiktok_handle: pinned.tiktokHandle,
      location: pinned.location,
      credits: pinned.credits,
      promotional_credits: pinned.promotionalCredits,
      saver_notice_seen_at: saverNoticeSeenAt,
    });
    const read = (row: ReturnType<typeof storedRow>) => getProfileRouteResult({
      request: new Request(`http://localhost${endpoint.path}`),
      dependencies: {
        createUserClient: () => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: pinned.id } }, error: null })) },
        }) as unknown as SupabaseClient,
        createServiceClient: () => ({
          from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
          rpc: async () => ({ data: null, error: null }),
        }) as unknown as SupabaseClient,
      },
    });

    const untold = await read(storedRow(null));
    expect(untold.status).toBe(200);
    expect(untold.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
    // Field for field, but the suggested handle the server makes for every account.
    expect(untold.body).toMatchObject(Object.fromEntries(
      Object.entries(pinned).filter(([field]) => field !== 'suggestedUsername'),
    ));
    expect(untold.body).toHaveProperty('saverNoticeSeen', pinned.saverNoticeSeen);

    const told = await read(storedRow('2026-10-19T09:00:00.000Z'));
    expect(told.body).toHaveProperty('saverNoticeSeen', true);
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

  // Recipe audit H4 (2026-10-27): both clients send the price the buyer
  // confirmed; a reprice in between is refused with the new price, nothing
  // spent. The request and the refusal are the fixture's, field for field.
  it('hands the confirmed price to the spend and answers a changed one in the fixture words', async () => {
    const endpoint = mobileApiContract.endpoints.unlockBundleWithCredits;
    const changed = endpoint.errors.priceChanged;
    const rpc = vi.fn(async () => ({
      data: {
        status: 'price_changed',
        remaining_credits: 5000,
        marketplace_spendable_credits: 5000,
        bundle_id: 'bundle-1',
        owner_user_id: 'creator-1',
        credit_cost: changed.response.priceCredits,
      },
      error: null,
    }));

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: new Request(`http://localhost${endpoint.path.replace(':postId', 'post-1')}`, {
        method: endpoint.method,
        headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
        body: JSON.stringify(endpoint.requestVariants.confirmedPrice),
      }),
      context: { params: Promise.resolve({ postId: 'post-1' }) },
      dependencies: {
        createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
        createUserClient: () => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'buyer-1' } }, error: null })) },
        }) as unknown as SupabaseClient,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 20,
          remaining: 19,
          retryAfterSeconds: 0,
          resetAt: '2026-10-27T08:30:00.000Z',
        })),
        isPostResourceBundleBuyWithheld: vi.fn(async () => false),
        runAfterResponse: vi.fn(),
      },
    });

    expect(rpc).toHaveBeenCalledWith('unlock_post_resource_bundle_with_credits', {
      p_user_id: 'buyer-1',
      p_post_id: 'post-1',
      p_expected_credit_cost: endpoint.requestVariants.confirmedPrice.expectedPriceCredits,
    });
    expect(response.status).toBe(changed.status);
    expect(response.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
    await expect(response.json()).resolves.toEqual(changed.response);
  });

  // Sold recipes can be corrected (owner decision D1): the editor reads how
  // many people have the recipe, and `hasPaidOrders` stays, always false, for
  // app builds that still read it.
  it('documents the owner post fields the composers read about a recipe’s buyers', () => {
    const post = mobileApiContract.endpoints.getOwnerPost.response.post;

    expect(post.hasPaidOrders).toBe(false);
    expect(post.resourceBundleBuyerCount).toBe(post.bundle.salesCount + post.bundle.freeUnlockCount);
  });

  // The unified start carries the price its quote showed (`expectedCostCredits`). The
  // start prices the run again and charges its own price up to that one; above it, or
  // for a price that is no whole number of credits, it answers in the fixture's words
  // before anything is held.
  it('starts the run the fixture sends at the price its quote showed, and refuses in the fixture words', async () => {
    const endpoint = mobileApiContract.endpoints.startGeneration;
    const quote = mobileApiContract.endpoints.quoteGenerationModel.response;
    expect(endpoint.request).toMatchObject({
      modelId: quote.modelId,
      catalogRevision: quote.catalogRevision,
      settings: quote.normalizedSettings,
      expectedCostCredits: quote.costCredits,
    });

    const records: BackendLogRecord[] = [];
    const restoreSink = setBackendLogSink((record) => {
      records.push(record);
    });
    const startPricedAt = (costCredits: number, body: Record<string, unknown> = endpoint.request) => {
      const startImage = vi.fn(async () => ({
        predictionId: endpoint.response.predictionId,
        generationId: endpoint.response.generationId,
        remainingCredits: endpoint.response.remainingCredits,
        cost: costCredits,
      }));
      const outcome = startUnifiedGenerationForRoute({
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': 'contract-start-1', 'x-magicbooklet-client': 'mobile' },
        }),
        body,
        userId: 'user-1',
        supabase: {} as SupabaseClient,
        // Just enough for the idempotent start: a claim, a lock, and no earlier attempt.
        adminSupabase: {
          rpc: vi.fn(async (fn: string) => ({ data: fn === 'claim_generation_start_request' ? 'claimed' : true, error: null })),
          from: vi.fn(() => {
            const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: null, error: null }) };
            return builder;
          }),
        } as unknown as SupabaseClient,
      }, {
        loadCatalog: vi.fn(async () => ({
          catalog: { schemaVersion: 2, revision: quote.catalogRevision, defaults: { image: quote.modelId, video: null, motion: null }, models: [] },
          operations: new Map([[quote.modelId, {
            modelId: quote.modelId,
            kind: 'image',
            adapterKey: 'image-v1',
            providerModelMap: {},
            adapterConfig: {},
            pricingStrategy: 'flat',
            pricingConfig: {},
            validationStrategy: 'descriptor-rules-v1',
            validationConfig: {},
            verificationConfig: {},
          }]]),
          source: 'database',
          releaseId: 'release-1',
          releaseSchemaVersion: 2,
        })) as never,
        quoteModel: vi.fn(() => ({ ...quote, costCredits })) as never,
        resolveSource: vi.fn(async () => null) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
        startImage: startImage as never,
      });
      return { outcome, startImage };
    };
    const answered = (outcome: Promise<unknown>) => outcome.then(
      () => null,
      (error: unknown) => mapGenerationStartRouteError(error, { logEvent: 'unified_generation_start_failed', fallbackMessage: 'Failed to start generation.' }),
    );

    try {
      // At the price shown, and below it: charged its own price, answered as the fixture says.
      const atPrice = startPricedAt(quote.costCredits);
      await expect(atPrice.outcome).resolves.toEqual(endpoint.response);
      expect(atPrice.startImage).toHaveBeenCalledWith(expect.objectContaining({ quotedCostCredits: quote.costCredits }));
      const below = startPricedAt(quote.costCredits - 1);
      await expect(below.outcome).resolves.toMatchObject({ cost: quote.costCredits - 1 });
      expect(below.startImage).toHaveBeenCalledWith(expect.objectContaining({ quotedCostCredits: quote.costCredits - 1 }));

      const above = startPricedAt(quote.costCredits + 1);
      expect(await answered(above.outcome)).toEqual({
        ok: false,
        status: endpoint.errors.costChanged.status,
        body: endpoint.errors.costChanged.response,
      });
      expect(above.startImage).not.toHaveBeenCalled();
      expect(records).toContainEqual(expect.objectContaining({
        level: 'error',
        msg: 'generation_start_quote_drift',
        client: 'mobile',
        expectedCostCredits: quote.costCredits,
        quotedCostCredits: quote.costCredits + 1,
      }));

      const malformed = startPricedAt(quote.costCredits, { ...endpoint.request, expectedCostCredits: String(quote.costCredits) });
      expect(await answered(malformed.outcome)).toEqual({
        ok: false,
        status: endpoint.errors.invalidExpectedCost.status,
        body: endpoint.errors.invalidExpectedCost.response,
      });
      expect(malformed.startImage).not.toHaveBeenCalled();
    } finally {
      restoreSink();
    }
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
