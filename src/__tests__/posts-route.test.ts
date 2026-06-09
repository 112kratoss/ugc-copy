import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getUserMock = vi.fn();
const uploadMock = vi.fn();
const removeMock = vi.fn();
const downloadMock = vi.fn();
const insertPayloads: Array<Record<string, unknown>> = [];
const postMediaRows: Array<Record<string, unknown>> = [];
const sourceToolRows: Array<Record<string, unknown>> = [];
const sourceToolRpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let bundleUpsertError: { code?: string; message?: string } | null = null;
let postMediaInsertError: { code?: string; message?: string } | null = null;
let sourceToolInsertError: { code?: string; message?: string } | null = null;

const sourceToolCatalog = vi.hoisted(() => [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
  { slug: 'higgsfield', label: 'Higgsfield', models: [{ slug: 'soul', label: 'Soul' }], supportedMediaKinds: ['image', 'video'] },
]);

function createRouteRequest(formData: FormData) {
  return {
    headers: new Headers({
      Authorization: 'Bearer test-token',
    }),
    formData: async () => formData,
  } as unknown as NextRequest;
}

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: () => getUserMock(),
    },
    from: (table: string) => {
      if (table === 'posts') {
        return {
          insert(payload: Record<string, unknown>) {
            insertPayloads.push(payload);
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: payload.id,
                        visibility: payload.visibility,
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'post_resource_bundles') {
        const query = {
          eq() {
            return query;
          },
          then(resolve: (value: { error: null }) => void) {
            resolve({ error: null });
          },
        };

        return {
          delete() {
            return query;
          },
          upsert() {
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: bundleUpsertError ? null : { id: 'bundle-1', post_id: 'post-1', status: 'published' },
                      error: bundleUpsertError,
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  }),
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'profiles') {
        const profile = {
          username: 'creator-one',
          display_name: 'Creator One',
        };
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: profile,
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_source_tools') {
        return {
          insert(payload: Array<Record<string, unknown>>) {
            sourceToolRows.push(...payload);
            return Promise.resolve({ error: sourceToolInsertError });
          },
        };
      }

      if (table === 'post_media') {
        return {
          insert(payload: Array<Record<string, unknown>>) {
            postMediaRows.push(...payload);
            return Promise.resolve({ error: postMediaInsertError });
          },
        };
      }

      if (table === 'posts') {
        const query = {
          delete() {
            return query;
          },
          eq() {
            return Promise.resolve({ error: null });
          },
        };

        return query;
      }

      throw new Error(`Unexpected service table access: ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'save_post_source_tools_with_catalog') {
        sourceToolRpcCalls.push({ name, args });
        const sourceTools = Array.isArray(args.p_source_tools)
          ? args.p_source_tools as Array<Record<string, unknown>>
          : [];
        sourceToolRows.push(...sourceTools.map((sourceTool, index) => ({
          tool_label: sourceTool.toolLabel,
          tool_slug: sourceTool.toolSlug,
          model_label: sourceTool.modelLabel ?? null,
          model_slug: sourceTool.modelSlug ?? null,
          sort_order: index,
        })));
        return Promise.resolve({
          data: null,
          error: sourceToolInsertError,
        });
      }
      if (name !== 'upsert_post_with_resource_bundle') {
        throw new Error(`Unexpected rpc call: ${name}`);
      }

      const post = args.p_post as Record<string, unknown>;
      insertPayloads.push(post);

      return Promise.resolve({
        data: bundleUpsertError
          ? null
          : [{
              post_id: post.id,
              visibility: post.visibility,
              bundle_id: (args.p_bundle as { accessMode?: string })?.accessMode && (args.p_bundle as { accessMode?: string }).accessMode !== 'none'
                ? 'bundle-1'
                : null,
              bundle_status: (args.p_bundle as { accessMode?: string })?.accessMode && (args.p_bundle as { accessMode?: string }).accessMode !== 'none'
                ? post.visibility === 'public' ? 'published' : 'draft'
                : null,
            }],
        error: bundleUpsertError,
      });
    },
    storage: {
      from: () => ({
        upload: uploadMock,
        remove: removeMock,
        download: downloadMock,
      }),
    },
  }),
}));

vi.mock('@/lib/source-tools-server', () => ({
  listSourceToolsCatalog: () => Promise.resolve(sourceToolCatalog),
}));

describe('/api/posts route', () => {
  beforeEach(() => {
    vi.resetModules();
    getUserMock.mockResolvedValue({
      data: {
        user: { id: 'user-1' },
      },
      error: null,
    });
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ error: null });
    removeMock.mockReset();
    removeMock.mockResolvedValue({ error: null });
    downloadMock.mockReset();
    downloadMock.mockResolvedValue({
      data: new Blob(['video-bytes'], { type: 'video/mp4' }),
      error: null,
    });
    insertPayloads.length = 0;
    postMediaRows.length = 0;
    sourceToolRows.length = 0;
    sourceToolRpcCalls.length = 0;
    bundleUpsertError = null;
    postMediaInsertError = null;
    sourceToolInsertError = null;
  });

  it('creates text-only posts without uploading media', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'Three hook ideas that keep working.\nLead with tension.');
    formData.set('visibility', 'public');

    const response = await POST(new Request('http://localhost/api/posts', {
      method: 'POST',
      body: formData,
      headers: {
        Authorization: 'Bearer test-token',
      },
    }) as NextRequest);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(insertPayloads).toHaveLength(1);
    expect(insertPayloads[0]).toMatchObject({
      user_id: 'user-1',
      category: 'text',
      post_format: 'text',
      source_kind: 'manual',
      body: 'Three hook ideas that keep working.\nLead with tension.',
      title: 'Three hook ideas that keep working.',
    });
    expect(payload.success).toBe(true);
    expect(payload.resourceBundlePath).toBe(`/showcase/${payload.postId}#resources`);
  });

  it('creates mixed posts with media and note content', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'mixed');
    formData.set('body', 'This cutdown worked because the hook hits in under two seconds.');
    formData.set('category', 'video');
    formData.set('visibility', 'unlisted');
    formData.set('sourceTool', 'Runway');
    formData.set('media', new File(['video-bytes'], 'hook.mp4', { type: 'video/mp4' }));

    const response = await POST(createRouteRequest(formData));
    expect(response.status).toBe(200);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(insertPayloads[0]).toMatchObject({
      category: 'video',
      post_format: 'mixed',
      source_kind: 'external',
      source_tool: 'Runway',
      visibility: 'unlisted',
      body: 'This cutdown worked because the hook hits in under two seconds.',
      title: 'This cutdown worked because the hook hits in under two seconds.',
    });
  });

  it('persists structured source tools for media posts', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'mixed');
    formData.set('body', 'This image was built with a specific external model.');
    formData.set('visibility', 'public');
    formData.set('media', new File(['image-bytes'], 'proof.png', { type: 'image/png' }));
    formData.set('sourceTools', JSON.stringify([
      {
        toolLabel: 'Higgsfield',
        toolSlug: 'higgsfield',
        modelLabel: 'Soul',
        modelSlug: 'soul',
      },
      {
        toolLabel: 'Runway',
        toolSlug: 'runway',
        modelLabel: 'Gen-4',
        modelSlug: 'gen-4',
      },
    ]));

    const response = await POST(createRouteRequest(formData));

    expect(response.status).toBe(200);
    expect(insertPayloads[0]).toMatchObject({
      source_tool: 'Higgsfield',
      source_tool_slug: 'higgsfield',
    });
    expect(sourceToolRows).toEqual([
      expect.objectContaining({
        tool_label: 'Higgsfield',
        tool_slug: 'higgsfield',
        model_label: 'Soul',
        model_slug: 'soul',
        sort_order: 0,
      }),
      expect.objectContaining({
        tool_label: 'Runway',
        tool_slug: 'runway',
        model_label: 'Gen-4',
        model_slug: 'gen-4',
        sort_order: 1,
      }),
    ]);
  });

  it('persists provisional catalog creation intent only after an image post is created', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'media');
    formData.set('visibility', 'public');
    formData.set('media', new File(['image-bytes'], 'proof.png', { type: 'image/png' }));
    formData.set('sourceTools', JSON.stringify([
      {
        toolLabel: 'Pika Labs',
        toolSlug: 'pika-labs',
        modelLabel: 'Pika 2.2',
        modelSlug: 'pika-2-2',
        createTool: true,
        createModel: true,
      },
    ]));

    const response = await POST(createRouteRequest(formData));

    expect(response.status).toBe(200);
    expect(sourceToolRpcCalls).toEqual([
      {
        name: 'save_post_source_tools_with_catalog',
        args: expect.objectContaining({
          p_owner_user_id: 'user-1',
          p_media_kind: 'image',
          p_source_tools: [
            expect.objectContaining({
              toolLabel: 'Pika Labs',
              createTool: true,
              createModel: true,
            }),
          ],
        }),
      },
    ]);
  });

  it('rejects invalid provisional catalog names before creating a post', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'media');
    formData.set('visibility', 'public');
    formData.set('media', new File(['image-bytes'], 'proof.png', { type: 'image/png' }));
    formData.set('sourceTools', JSON.stringify([
      {
        toolLabel: 'x'.repeat(81),
        createTool: true,
      },
    ]));

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/80 characters/i);
    expect(payload.field).toBe('sourceTools');
    expect(insertPayloads).toHaveLength(0);
    expect(sourceToolRpcCalls).toHaveLength(0);
  });

  it('fails post creation when source tool metadata cannot be saved', async () => {
    sourceToolInsertError = { message: 'source tool write failed' };

    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'mixed');
    formData.set('body', 'This image should not publish with missing source metadata.');
    formData.set('visibility', 'public');
    formData.set('media', new File(['image-bytes'], 'proof.png', { type: 'image/png' }));
    formData.set('sourceTools', JSON.stringify([
      {
        toolLabel: 'Higgsfield',
        toolSlug: 'higgsfield',
        modelLabel: 'Soul',
        modelSlug: 'soul',
      },
    ]));

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toMatch(/source tool/i);
    expect(removeMock).toHaveBeenCalledWith([expect.stringContaining('posts/')]);
  });

  it('creates mixed posts from an uploaded storage reference without raw multipart media', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'mixed');
    formData.set('body', 'Keep the product benefit visible before the hook resolves.');
    formData.set('category', 'video');
    formData.set('visibility', 'public');
    formData.set('sourceTool', 'CapCut');
    formData.set('mediaStoragePath', 'uploads/user-1/tmp-proof.mp4');
    formData.set('mediaOriginalName', 'proof.mp4');
    formData.set('mediaContentType', 'video/mp4');

    const response = await POST(createRouteRequest(formData));

    expect(response.status).toBe(200);
    expect(downloadMock).toHaveBeenCalledWith('user-1/tmp-proof.mp4');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(['user-1/tmp-proof.mp4']);
    expect(insertPayloads[0]).toMatchObject({
      category: 'video',
      post_format: 'mixed',
      source_kind: 'external',
      source_tool: 'CapCut',
      visibility: 'public',
      body: 'Keep the product benefit visible before the hook resolves.',
      title: 'Keep the product benefit visible before the hook resolves.',
    });
    expect(postMediaRows).toEqual([
      expect.objectContaining({
        post_id: expect.any(String),
        storage_path: expect.stringContaining('posts/'),
        media_kind: 'video',
        content_type: 'video/mp4',
        sort_order: 0,
      }),
    ]);
  });

  it('creates ordered multi-media posts from uploaded storage references', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'media');
    formData.set('visibility', 'public');
    formData.set('category', 'image');
    formData.set('sourceTool', 'Runway');
    formData.set('mediaItems', JSON.stringify([
      {
        storagePath: 'uploads/user-1/cover.png',
        originalName: 'cover.png',
        contentType: 'image/png',
      },
      {
        storagePath: 'uploads/user-1/clip.mp4',
        originalName: 'clip.mp4',
        contentType: 'video/mp4',
      },
    ]));

    const response = await POST(createRouteRequest(formData));

    expect(response.status).toBe(200);
    expect(downloadMock).toHaveBeenCalledWith('user-1/cover.png');
    expect(downloadMock).toHaveBeenCalledWith('user-1/clip.mp4');
    expect(uploadMock).toHaveBeenCalledTimes(2);
    expect(removeMock).toHaveBeenCalledWith(['user-1/cover.png', 'user-1/clip.mp4']);
    expect(insertPayloads[0]).toMatchObject({
      category: 'image',
      post_format: 'media',
      showcase_asset_path: expect.stringMatching(/posts\/.+\/cover\.png/),
    });
    expect(postMediaRows).toEqual([
      expect.objectContaining({
        storage_path: expect.stringMatching(/posts\/.+\/cover\.png/),
        media_kind: 'image',
        content_type: 'image/png',
        original_name: 'cover.png',
        sort_order: 0,
      }),
      expect.objectContaining({
        storage_path: expect.stringMatching(/posts\/.+\/clip\.mp4/),
        media_kind: 'video',
        content_type: 'video/mp4',
        original_name: 'clip.mp4',
        sort_order: 1,
      }),
    ]);
  });

  it('returns a schema-specific error when post media storage is not enabled', async () => {
    postMediaInsertError = {
      code: 'PGRST205',
      message: "Could not find the table 'public.post_media' in the schema cache",
    };

    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'media');
    formData.set('visibility', 'public');
    formData.set('category', 'image');
    formData.set('mediaItems', JSON.stringify([
      {
        storagePath: 'uploads/user-1/cover.png',
        originalName: 'cover.png',
        contentType: 'image/png',
      },
      {
        storagePath: 'uploads/user-1/detail.png',
        originalName: 'detail.png',
        contentType: 'image/png',
      },
    ]));

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toMatch(/post media gallery migration/i);
    expect(removeMock).toHaveBeenCalledWith([
      expect.stringMatching(/^posts\/.+\/cover\.png$/),
      expect.stringMatching(/^posts\/.+\/detail\.png$/),
    ]);
    expect(removeMock).toHaveBeenCalledWith(['user-1/cover.png', 'user-1/detail.png']);
  });

  it('rejects manual posts with more than five media items', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'media');
    formData.set('visibility', 'public');
    formData.set('mediaItems', JSON.stringify(
      Array.from({ length: 6 }, (_, index) => ({
        storagePath: `uploads/user-1/item-${index}.png`,
        originalName: `item-${index}.png`,
        contentType: 'image/png',
      }))
    ));

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/up to 5 media/i);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(insertPayloads).toHaveLength(0);
    expect(postMediaRows).toHaveLength(0);
  });

  it('rejects empty submissions', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/add a note or upload media/i);
    expect(insertPayloads).toHaveLength(0);
  });

  it('rejects overlength text posts', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'a'.repeat(2001));

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/limited to 2000 characters/i);
    expect(insertPayloads).toHaveLength(0);
  });

  it('rejects paid unlocks without any resource content', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'The hook works because it resolves the objection before the demo.');
    formData.set('visibility', 'public');
    formData.set(
      'resourceBundle',
      JSON.stringify({
        accessMode: 'paid',
        priceUsdCents: 500,
        resources: {
          promptText: ' ',
          notesMarkdown: '',
          workflowShareUrl: '',
          attachments: [],
          allowRemix: false,
        },
      })
    );

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/add content/i);
    expect(insertPayloads).toHaveLength(0);
  });

  it('rejects unlock file attachments outside the creator storage prefix', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'A short post with a gated workflow file.');
    formData.set('visibility', 'public');
    formData.set(
      'resourceBundle',
      JSON.stringify({
        accessMode: 'free',
        resources: {
          attachments: [{
            label: 'Workflow export',
            kind: 'file',
            storagePath: 'someone-else/workflow.json',
          }],
          allowRemix: false,
        },
      })
    );

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/belong to the creator/i);
    expect(insertPayloads).toHaveLength(0);
  });

  it('rejects low-quality marketplace unlock listings before publishing', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('title', 'test text');
    formData.set('body', 'A useful public proof post that explains the reusable hook structure.');
    formData.set('visibility', 'public');
    formData.set(
      'resourceBundle',
      JSON.stringify({
        accessMode: 'paid',
        summary: 'A reusable launch prompt for a proof-led product hook.',
        previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
        priceUsdCents: 500,
        resources: {
          promptText: 'Use a before and after hook with one product proof frame and a short CTA.',
          attachments: [],
          allowRemix: false,
        },
      })
    );

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/improve this unlock before publishing/i);
    expect(payload.error).toMatch(/placeholder listing title/i);
    expect(insertPayloads).toHaveLength(0);
  });

  it('saves private unlock posts as draft bundles without marketplace quality gating', async () => {
    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('title', 'Helpful launch proof');
    formData.set('body', 'A useful draft proof post that is not ready for marketplace discovery.');
    formData.set('visibility', 'private');
    formData.set(
      'resourceBundle',
      JSON.stringify({
        accessMode: 'paid',
        summary: 'A reusable launch prompt for a proof-led product hook.',
        previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
        priceUsdCents: 500,
        resources: {
          promptText: 'Use a before and after hook with one product proof frame and a short CTA.',
          attachments: [],
          allowRemix: false,
        },
      })
    );

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(insertPayloads[0]).toMatchObject({
      visibility: 'private',
    });
    expect(payload.visibility).toBe('private');
    expect(payload.resourceBundleStatus).toBe('draft');
    expect(payload.resourceBundlePath).toBe(`/post/${payload.postId}/edit#resources`);
  });

  it('surfaces a clear migration error when post resource bundles are not enabled yet', async () => {
    bundleUpsertError = {
      code: 'PGRST205',
      message: "Could not find the table 'public.post_resource_bundles' in the schema cache",
    };

    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'text');
    formData.set('body', 'Hook first, then show the product payoff.');
    formData.set('visibility', 'public');
    formData.set(
      'resourceBundle',
      JSON.stringify({
        accessMode: 'paid',
        summary: 'A reusable launch prompt for a proof-led product hook.',
        previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
        priceUsdCents: 200,
        resources: {
          promptText: 'Hook first, then show the product payoff with one proof frame and a short CTA.',
          attachments: [],
          allowRemix: false,
        },
      })
    );

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toMatch(/atomic unlock publishing is not enabled/i);
    expect(payload.error).toMatch(/20260508120000_post_system_marketplace_reliability\.sql/i);
  });

  it('removes uploaded media when the atomic post publish fails', async () => {
    bundleUpsertError = {
      message: 'bundle write failed',
    };

    const { POST } = await import('@/app/api/posts/route');
    const formData = new FormData();
    formData.set('postFormat', 'mixed');
    formData.set('body', 'This post should not survive a failed unlock save.');
    formData.set('category', 'image');
    formData.set('visibility', 'public');
    formData.set('media', new File(['image-bytes'], 'proof.png', { type: 'image/png' }));
    formData.set(
      'resourceBundle',
      JSON.stringify({
        accessMode: 'paid',
        summary: 'A reusable launch prompt for a proof-led product hook.',
        previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
        priceUsdCents: 200,
        resources: {
          promptText: 'Prompt buyers should unlock with one proof frame and a concise CTA.',
          attachments: [],
          allowRemix: false,
        },
      })
    );

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toMatch(/failed to create post/i);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith([expect.stringContaining('posts/')]);
  });
});
