import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getUserMock = vi.fn();
const uploadMock = vi.fn();
const removeMock = vi.fn();
const insertPayloads: Array<Record<string, unknown>> = [];

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
    from: () => ({
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
    }),
  }),
  createServiceClient: () => ({
    storage: {
      from: () => ({
        upload: uploadMock,
        remove: removeMock,
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
    insertPayloads.length = 0;
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
});
