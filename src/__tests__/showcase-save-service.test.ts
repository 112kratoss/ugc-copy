import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  saveShowcasePostForRoute,
  type ShowcaseSaveServiceDependencies,
} from '@/lib/showcase-save-service';

function createServiceClientMock() {
  const eventInsertMock = vi.fn(async () => ({ data: null, error: null }));
  const rpcMock = vi.fn(async (fn: string) => {
    if (fn === 'set_post_save_state') {
      return {
        data: [{
          is_saved: true,
          save_count: 5,
          changed: true,
        }],
        error: null,
      };
    }

    throw new Error(`Unexpected RPC: ${fn}`);
  });
  const fromMock = vi.fn((table: string) => {
    if (table !== 'post_save_events') {
      throw new Error(`Unexpected table: ${table}`);
    }

    return { insert: eventInsertMock };
  });

  return {
    client: {
      from: fromMock,
      rpc: rpcMock,
    } as unknown as SupabaseClient,
    eventInsertMock,
    fromMock,
    rpcMock,
  };
}

describe('saveShowcasePostForRoute', () => {
  it('idempotently saves a post, records analytics, and notifies when save state changes', async () => {
    const serviceClient = createServiceClientMock();
    const notifyPostSocialActivity = vi.fn(async () => undefined);
    const dependencies = {
      findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => ({
        id: 'post-1',
        generation_id: 'gen-1',
        user_id: 'creator-1',
      })),
      isMissingPostsSchemaError: vi.fn(() => false),
      isUserRelationshipBlocked: vi.fn(async () => false),
      notifyPostSocialActivity,
    } satisfies Partial<ShowcaseSaveServiceDependencies>;

    const result = await saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        isSaved: true,
        saveCount: 5,
        changed: true,
        message: 'Saved to bookmarks',
      },
    });
    expect(serviceClient.rpcMock).toHaveBeenCalledWith('set_post_save_state', {
      p_post_id: 'post-1',
      p_user_id: 'user-1',
      p_should_save: true,
    });
    expect(serviceClient.eventInsertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      post_id: 'post-1',
      requested_state: true,
      result_state: true,
      changed: true,
      source_surface: 'showcase',
    });
    expect(notifyPostSocialActivity).toHaveBeenCalledWith(serviceClient.client, {
      type: 'post_saved',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it.each([
    ['a block', vi.fn(async () => true)],
    ['an unavailable block lookup', vi.fn(async () => { throw new Error('block lookup failed'); })],
  ])('fails closed before saving or notifying when there is %s', async (_label, isUserRelationshipBlocked) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const serviceClient = createServiceClientMock();
    const notifyPostSocialActivity = vi.fn(async () => undefined);

    const result = await saveShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      requestedSaveState: true,
      serviceClient: serviceClient.client,
      sourceSurface: 'showcase',
      dependencies: {
        findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => ({
          id: 'post-1',
          generation_id: 'gen-1',
          user_id: 'creator-1',
        })),
        isMissingPostsSchemaError: vi.fn(() => false),
        isUserRelationshipBlocked,
        notifyPostSocialActivity,
      },
    });

    expect(result).toEqual({ ok: false, status: 404, body: { error: 'Post not found' } });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(serviceClient.eventInsertMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivity).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
