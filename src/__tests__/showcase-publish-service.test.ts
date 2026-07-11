import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  publishGenerationToShowcaseForRoute,
  type ShowcasePublishServiceDependencies,
} from '@/lib/showcase-publish-service';

function createUserClientMock(generation: Record<string, unknown>) {
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];

  return {
    client: {
      from(table: string) {
        if (table !== 'generations') {
          throw new Error(`Unexpected user table: ${table}`);
        }

        return {
          select(columns = '') {
            selects.push(columns);
            return {
              eq(column: string, value: unknown) {
                eqs.push({ column, value });
                return {
                  single() {
                    return Promise.resolve({
                      data: generation.id === value ? generation : null,
                      error: generation.id === value ? null : { message: 'not found' },
                    });
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient,
    eqs,
    selects,
  };
}

function createAdminClientMock() {
  const removeMock = vi.fn(async () => ({ data: null, error: null }));

  return {
    client: {
      storage: {
        from: vi.fn(() => ({
          remove: removeMock,
        })),
      },
    } as unknown as SupabaseClient,
    removeMock,
  };
}

describe('publishGenerationToShowcaseForRoute', () => {
  it('publishes a generation-backed post as private and removes the old showcase derivative', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: 'showcase/gen-1/example.jpg',
      title: 'Original title',
      description: 'Original description',
      prompt: 'Original prompt',
    };
    const userClient = createUserClientMock(generation);
    const adminClient = createAdminClientMock();
    const publishGenerationPostWithResourceBundleAtomically = vi.fn(async () => ({
      postId: 'post-1',
      visibility: 'private' as const,
      bundleStatus: null,
    }));
    const dependencies = {
      ensureDurableGenerationMedia: vi.fn(async ({ generation: mediaGeneration }) => ({
        outputUrl: mediaGeneration.outputUrl,
        createdLocation: null,
      })),
      listSourceToolsCatalog: vi.fn(async () => [
        { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
      ]),
      publishGenerationPostWithResourceBundleAtomically,
    } satisfies Partial<ShowcasePublishServiceDependencies>;

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'private',
      },
      supabase: userClient.client,
      userId: 'user-1',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        isPublic: false,
        visibility: 'private',
        postId: 'post-1',
        showcasePath: null,
        ownerPath: '/post/post-1/edit',
        resourceBundlePath: '/post/post-1/edit#resources',
        resourceBundleStatus: null,
        message: 'Saved as a private post',
      },
    });
    expect(userClient.selects[0]).toContain('showcase_asset_path');
    expect(userClient.eqs).toEqual([{ column: 'id', value: 'gen-1' }]);
    expect(publishGenerationPostWithResourceBundleAtomically).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 'gen-1',
      ownerUserId: 'user-1',
      generationUpdate: expect.objectContaining({
        is_public: false,
        share_input_media_for_remix: false,
        showcase_asset_path: null,
      }),
      post: expect.objectContaining({
        generation_id: 'gen-1',
        output_url: 'generated_images/user-1/example.jpg',
        showcase_asset_path: null,
        visibility: 'private',
      }),
      hasBundlePayload: false,
    }));
    expect(adminClient.removeMock).toHaveBeenCalledWith(['showcase/gen-1/example.jpg']);
  });

  it('returns an actionable profile repair response for public publishing', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Original title',
      description: 'Original description',
      prompt: 'Original prompt',
    };
    const userClient = createUserClientMock(generation);
    const adminClient = createAdminClientMock();
    const publishGenerationPostWithResourceBundleAtomically = vi.fn();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: {
        generationId: 'gen-1',
        visibility: 'public',
      },
      supabase: userClient.client,
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
          'Complete your profile before publishing publicly: choose a custom handle and add your display name.'
        )),
        publishGenerationPostWithResourceBundleAtomically,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: 'Complete your profile before publishing publicly: choose a custom handle and add your display name.',
        field: 'profile',
        actionHref: '/profile',
        actionLabel: 'Complete profile and return',
      },
    });
    expect(publishGenerationPostWithResourceBundleAtomically).not.toHaveBeenCalled();
  });

  it('returns a retryable server failure when profile verification is unavailable', async () => {
    const generation = {
      id: 'gen-1',
      user_id: 'user-1',
      status: 'succeeded',
      model: 'nano-banana-2',
      category: 'image',
      creation_mode: null,
      output_url: 'generated_images/user-1/example.jpg',
      showcase_asset_path: null,
      title: 'Original title',
      description: 'Original description',
      prompt: 'Original prompt',
    };
    const userClient = createUserClientMock(generation);
    const adminClient = createAdminClientMock();

    const result = await publishGenerationToShowcaseForRoute({
      adminSupabase: adminClient.client,
      body: { generationId: 'gen-1', visibility: 'public' },
      supabase: userClient.client,
      userId: 'user-1',
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
          'Could not verify your creator profile right now. Try again.'
        )),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Could not verify your creator profile right now. Try again.' },
    });
  });
});
