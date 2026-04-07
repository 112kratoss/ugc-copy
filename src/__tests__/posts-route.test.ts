import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getUserMock = vi.fn();
const uploadMock = vi.fn();
const removeMock = vi.fn();
const downloadMock = vi.fn();
const insertPayloads: Array<Record<string, unknown>> = [];
let bundleUpsertError: { code?: string; message?: string } | null = null;

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
    storage: {
      from: () => ({
        upload: uploadMock,
        remove: removeMock,
        download: downloadMock,
      }),
    },
  }),
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
    bundleUpsertError = null;
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
        priceUsdCents: 200,
        resources: {
          promptText: 'Hook first, then show the product payoff.',
          attachments: [],
          allowRemix: false,
        },
      })
    );

    const response = await POST(createRouteRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toMatch(/resource bundles are not enabled/i);
    expect(payload.error).toMatch(/20260406200000_post_resource_bundles\.sql/i);
  });
});
