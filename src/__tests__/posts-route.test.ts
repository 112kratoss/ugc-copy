import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getUserMock = vi.fn();
const uploadMock = vi.fn();
const removeMock = vi.fn();
const downloadMock = vi.fn();
const insertPayloads: Array<Record<string, unknown>> = [];
const sourceToolRows: Array<Record<string, unknown>> = [];
let bundleUpsertError: { code?: string; message?: string } | null = null;
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
    sourceToolRows.length = 0;
    bundleUpsertError = null;
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
