import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  parseShowcaseSharePayloadForRoute,
  shareShowcasePostForRoute,
  type ShowcaseShareServiceDependencies,
} from '@/lib/showcase-share-service';

function createServiceClientMock() {
  return {
    client: { service: true } as unknown as SupabaseClient,
  };
}

/**
 * Derived from the real dependency rather than restated as
 * `Record<string, unknown>`, which does not satisfy the service's declared
 * return type and would drift as the row shape changes.
 */
type SharePostReference = Awaited<
  ReturnType<ShowcaseShareServiceDependencies['findPublicPostReferenceByIdOrGenerationId']>
>;

function createDependencies(
  post: SharePostReference = {
    id: 'post-1',
    generation_id: 'gen-1',
    user_id: 'creator-1',
    visibility: 'public',
    category: 'image',
    prompt: 'a prompt',
    source_kind: 'magicbooklet',
  },
) {
  return {
    findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => post),
    isUserRelationshipBlocked: vi.fn(async () => false),
    // `null`, not `undefined`: the real notifier returns null when it declines
    // to send, and never returns undefined.
    notifyPostSocialActivity: vi.fn(async () => null),
    recordPostShareEvent: vi.fn(async () => undefined),
  } satisfies Partial<ShowcaseShareServiceDependencies>;
}

describe('parseShowcaseSharePayloadForRoute', () => {
  it('prefers post ids over generation ids and validates share metadata', () => {
    const result = parseShowcaseSharePayloadForRoute({
      generationId: 'gen-1',
      postId: 'post-1',
      sourceSurface: 'showcase',
      channel: 'copy-link',
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        referenceId: 'post-1',
        sourceSurface: 'showcase',
        channel: 'copy-link',
      },
    });
  });

  it.each([
    [{ sourceSurface: 'showcase', channel: 'copy-link' }, 'Missing post ID'],
    [{ postId: 'post-1', sourceSurface: 'invalid', channel: 'copy-link' }, 'Invalid share source surface'],
    [{ postId: 'post-1', sourceSurface: 'showcase', channel: 'invalid' }, 'Invalid share channel'],
  ])('returns route-ready validation errors for malformed payloads', (body, expectedError) => {
    const result = parseShowcaseSharePayloadForRoute(body);

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: expectedError },
    });
  });
});

describe('shareShowcasePostForRoute', () => {
  it('records authenticated share clicks for public posts and notifies creators', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(dependencies.findPublicPostReferenceByIdOrGenerationId).toHaveBeenCalledWith(
      'post-1',
      serviceClient.client,
    );
    expect(dependencies.recordPostShareEvent).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_click',
      sourceSurface: 'showcase',
      channel: 'copy-link',
      actorUserId: 'user-1',
    }, serviceClient.client);
    expect(dependencies.notifyPostSocialActivity).toHaveBeenCalledWith(serviceClient.client, {
      type: 'post_shared',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it('records anonymous share clicks without notifying creators', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await shareShowcasePostForRoute({
      actorUserId: null,
      channel: 'native-share',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      sourceSurface: 'detail-page',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(dependencies.recordPostShareEvent).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_click',
      sourceSurface: 'detail-page',
      channel: 'native-share',
      actorUserId: null,
    }, serviceClient.client);
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects blocked creator interactions before recording or notifying shares', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();
    dependencies.isUserRelationshipBlocked.mockResolvedValue(true);

    const result = await shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-1',
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Only public creations can be shared' },
    });
    expect(dependencies.recordPostShareEvent).not.toHaveBeenCalled();
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects private or missing post references before recording share events', async () => {
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies(null);

    const result = await shareShowcasePostForRoute({
      actorUserId: 'user-1',
      channel: 'copy-link',
      referenceId: 'post-2',
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Only public creations can be shared' },
    });
    expect(dependencies.recordPostShareEvent).not.toHaveBeenCalled();
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });
});
