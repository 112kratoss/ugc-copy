import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  remixShowcasePostForRoute,
  type ShowcaseRemixServiceDependencies,
} from '@/lib/showcase-remix-service';

type GenerationQueryOptions = {
  generation?: Record<string, unknown> | null;
  generationError?: unknown;
};

function createUserClientMock({
  generation = {
    id: 'gen-1',
    prompt: 'Create a clean UGC product reveal.',
    workflow_settings: { model: 'nano-banana-2' },
  },
  generationError = null,
}: GenerationQueryOptions = {}) {
  const singleMock = vi.fn(async () => ({
    data: generation,
    error: generationError,
  }));
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  const fromMock = vi.fn((table: string) => {
    if (table !== 'generations') {
      throw new Error(`Unexpected table: ${table}`);
    }

    return { select: selectMock };
  });

  return {
    client: { from: fromMock } as unknown as SupabaseClient,
    eqMock,
    fromMock,
    selectMock,
    singleMock,
  };
}

function createServiceClientMock({ rpcError = null }: { rpcError?: unknown } = {}) {
  const rpcMock = vi.fn(async () => ({
    data: true,
    error: rpcError,
  }));

  return {
    client: { rpc: rpcMock } as unknown as SupabaseClient,
    rpcMock,
  };
}

/**
 * Derived from the real dependency rather than restated as
 * `Record<string, unknown>`: the loose shape does not satisfy the service's
 * declared return type, and hard-coding a literal here would drift the moment
 * the row shape changes.
 */
type RemixPostReference = Awaited<
  ReturnType<ShowcaseRemixServiceDependencies['findPublicPostReferenceByIdOrGenerationId']>
>;

type RemixPostCategory = NonNullable<RemixPostReference>['category'];

function createDependencies(
  // The previous fixture omitted visibility, prompt, and source_kind. Those are
  // required on PostReferenceRow, and the service reads visibility to decide
  // whether a post may be remixed at all — so the fixture was not merely
  // incomplete, it was under-specifying the field the behaviour turns on.
  post: RemixPostReference = {
    id: 'post-1',
    generation_id: 'gen-1',
    user_id: 'creator-1',
    category: 'image',
    visibility: 'public',
    prompt: 'a prompt',
    source_kind: 'magicbooklet',
  },
) {
  return {
    findPublicPostReferenceByIdOrGenerationId: vi.fn(async () => post),
    isUserRelationshipBlocked: vi.fn(async () => false),
    // `null`, not `undefined`: the real notifier returns null when it declines
    // to send (missing recipient or actor), and never returns undefined.
    notifyPostSocialActivity: vi.fn(async () => null),
  } satisfies Partial<ShowcaseRemixServiceDependencies>;
}

describe('remixShowcasePostForRoute', () => {
  it('increments the public post remix count and returns generation prefill data', async () => {
    const userClient = createUserClientMock();
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      userClient: userClient.client,
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        redirectTo: '/create-image?remix=gen-1&remixPost=post-1',
        prefill: {
          prompt: 'Create a clean UGC product reveal.',
          settings: { model: 'nano-banana-2' },
        },
      },
    });
    expect(dependencies.findPublicPostReferenceByIdOrGenerationId).toHaveBeenCalledWith(
      'post-1',
      serviceClient.client,
    );
    expect(serviceClient.rpcMock).toHaveBeenCalledWith('increment_post_remix_count', {
      p_post_id: 'post-1',
    });
    expect(userClient.fromMock).toHaveBeenCalledWith('generations');
    expect(userClient.selectMock).toHaveBeenCalledWith('id, prompt, workflow_settings');
    expect(userClient.eqMock).toHaveBeenCalledWith('id', 'gen-1');
    expect(dependencies.notifyPostSocialActivity).toHaveBeenCalledWith(serviceClient.client, {
      type: 'post_remixed',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it.each([
    ['video', '/create-video'],
    ['ugc-ad', '/create-video'],
    ['motion', '/create-motion'],
    ['unknown', '/create'],
    [null, '/create'],
  ] as Array<[RemixPostCategory, string]>)(
    'maps %s posts to the expected remix creator path', async (category, expectedPath) => {
    const userClient = createUserClientMock();
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies({
      id: 'post-1',
      generation_id: 'gen-1',
      user_id: 'creator-1',
      category,
      visibility: 'public',
      prompt: 'a prompt',
      source_kind: 'magicbooklet',
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      userClient: userClient.client,
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.body.redirectTo : null).toBe(`${expectedPath}?remix=gen-1&remixPost=post-1`);
  });

  it('rejects private or missing post references before remix mutation work', async () => {
    const userClient = createUserClientMock();
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies(null);

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'missing-post',
      userClient: userClient.client,
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Creation is private or not found' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(userClient.fromMock).not.toHaveBeenCalled();
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects blocked creator interactions before remix counters, media reads, or notifications', async () => {
    const userClient = createUserClientMock();
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();
    dependencies.isUserRelationshipBlocked.mockResolvedValue(true);

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      userClient: userClient.client,
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Creation is private or not found' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(userClient.fromMock).not.toHaveBeenCalled();
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('rejects posts that are not backed by a generation before incrementing remix count', async () => {
    const userClient = createUserClientMock();
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies({
      id: 'post-1',
      generation_id: null,
      user_id: 'creator-1',
      category: 'image',
      visibility: 'public',
      prompt: 'a prompt',
      source_kind: 'magicbooklet',
    });

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      userClient: userClient.client,
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Only generation-backed posts can be remixed' },
    });
    expect(serviceClient.rpcMock).not.toHaveBeenCalled();
    expect(userClient.fromMock).not.toHaveBeenCalled();
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });

  it('keeps remix available when the best-effort remix counter fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const userClient = createUserClientMock();
    const serviceClient = createServiceClientMock({
      rpcError: { message: 'rpc unavailable' },
    });
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      userClient: userClient.client,
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result.ok).toBe(true);
    const remixLog = JSON.parse(consoleError.mock.calls[0][0] as string);
    expect(remixLog.msg).toBe('error_incrementing_remix_count');
    expect(remixLog.errorMessage).toBe('rpc unavailable');

    consoleError.mockRestore();
  });

  it('rejects missing linked generations before notifying the creator', async () => {
    const userClient = createUserClientMock({
      generation: null,
      generationError: { message: 'not found' },
    });
    const serviceClient = createServiceClientMock();
    const dependencies = createDependencies();

    const result = await remixShowcasePostForRoute({
      actorUserId: 'user-1',
      referenceId: 'post-1',
      userClient: userClient.client,
      serviceClient: serviceClient.client,
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Linked generation not found' },
    });
    expect(serviceClient.rpcMock).toHaveBeenCalledWith('increment_post_remix_count', {
      p_post_id: 'post-1',
    });
    expect(dependencies.notifyPostSocialActivity).not.toHaveBeenCalled();
  });
});
