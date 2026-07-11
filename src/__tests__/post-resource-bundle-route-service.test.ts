import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getPostResourceBundleForRoute,
  putPostResourceBundleForRoute,
} from '@/lib/post-resource-bundle-route-service';

const validBundleBody = {
  resourceBundle: {
    accessMode: 'paid',
    summary: 'A reusable launch prompt for a proof-led product hook.',
    previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
    priceUsdCents: 500,
    resources: {
      promptText: 'Use a before and after hook with one product proof frame and a short CTA.',
      attachments: [],
      allowRemix: false,
    },
  },
};

type PostRow = {
  id: string;
  user_id: string;
  title: string | null;
  body: string | null;
  visibility: string | null;
  archived_at: string | null;
  review_status: string | null;
  showcase_asset_path: string | null;
  output_url: string | null;
};

function createUserSupabaseMock(post: PostRow | null) {
  const tableCalls: string[] = [];

  const client = {
    from(table: string) {
      tableCalls.push(table);
      if (table !== 'posts') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        async maybeSingle() {
          return {
            data: post,
            error: null,
          };
        },
      };

      return query;
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    tableCalls,
  };
}

function createAdminSupabaseMock(allowed: boolean) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 60,
      remaining: allowed ? 59 : 0,
      retryAfterSeconds: allowed ? 0 : 30,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));

  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
  };
}

function privatePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: 'post-1',
    user_id: 'user-1',
    title: 'Draft post',
    body: 'A private proof post with a draft unlock.',
    visibility: 'private',
    archived_at: null,
    review_status: 'visible',
    showcase_asset_path: null,
    output_url: null,
    ...overrides,
  };
}

describe('getPostResourceBundleForRoute', () => {
  it('loads bundle detail with viewer and country context', async () => {
    const getDetailByPostId = vi.fn(async () => ({ id: 'bundle-1', accessMode: 'free' }));

    const result = await getPostResourceBundleForRoute({
      postId: 'post-1',
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
      getDetailByPostId,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        bundle: { id: 'bundle-1', accessMode: 'free' },
      },
    });
    expect(getDetailByPostId).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    });
  });
});

describe('putPostResourceBundleForRoute', () => {
  it('rate limits before parsing the request body or loading the post', async () => {
    const userSupabase = createUserSupabaseMock(privatePost());
    const adminSupabase = createAdminSupabaseMock(false);
    const readBody = vi.fn(async () => validBundleBody);

    const result = await putPostResourceBundleForRoute({
      postId: 'post-1',
      ownerUserId: 'user-1',
      userSupabase: userSupabase.client,
      adminSupabase: adminSupabase.client,
      readBody,
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('rateLimitError');
    expect(readBody).not.toHaveBeenCalled();
    expect(userSupabase.tableCalls).toEqual([]);
  });

  it('saves private draft unlock bundles without marketplace quality gating', async () => {
    const userSupabase = createUserSupabaseMock(privatePost());
    const adminSupabase = createAdminSupabaseMock(true);
    const getMarketplaceQualityErrorForPostBundle = vi.fn(async () => 'Quality should not run.');
    const savePostResourceBundle = vi.fn(async () => ({ id: 'bundle-1', status: 'draft' }));

    const result = await putPostResourceBundleForRoute({
      postId: 'post-1',
      ownerUserId: 'user-1',
      userSupabase: userSupabase.client,
      adminSupabase: adminSupabase.client,
      readBody: vi.fn(async () => validBundleBody),
      dependencies: {
        getMarketplaceQualityErrorForPostBundle,
        savePostResourceBundle,
      },
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        bundle: { id: 'bundle-1', status: 'draft' },
      },
    });
    expect(getMarketplaceQualityErrorForPostBundle).not.toHaveBeenCalled();
    expect(savePostResourceBundle).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      postId: 'post-1',
      postTitle: 'Draft post',
      postVisibility: 'private',
    }));
  });

  it('rejects public bundle saves that fail marketplace quality gates', async () => {
    const userSupabase = createUserSupabaseMock(privatePost({ visibility: 'public' }));
    const adminSupabase = createAdminSupabaseMock(true);
    const savePostResourceBundle = vi.fn(async () => ({ id: 'bundle-1' }));

    const result = await putPostResourceBundleForRoute({
      postId: 'post-1',
      ownerUserId: 'user-1',
      userSupabase: userSupabase.client,
      adminSupabase: adminSupabase.client,
      readBody: vi.fn(async () => validBundleBody),
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => 'Add a clear unlock preview.'),
        savePostResourceBundle,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Add a clear unlock preview.' },
    });
    expect(savePostResourceBundle).not.toHaveBeenCalled();
  });

  it('maps unavailable profile verification to a server failure', async () => {
    const userSupabase = createUserSupabaseMock(privatePost({ visibility: 'public' }));
    const adminSupabase = createAdminSupabaseMock(true);

    const result = await putPostResourceBundleForRoute({
      postId: 'post-1',
      ownerUserId: 'user-1',
      userSupabase: userSupabase.client,
      adminSupabase: adminSupabase.client,
      readBody: vi.fn(async () => validBundleBody),
      dependencies: {
        getMarketplaceQualityErrorForPostBundle: vi.fn(async () => (
          'Could not verify your creator profile right now. Try again.'
        )),
        savePostResourceBundle: vi.fn(),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Could not verify your creator profile right now. Try again.' },
    });
  });
});
