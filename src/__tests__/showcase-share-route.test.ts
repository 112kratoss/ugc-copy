import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordPostShareEventMock = vi.fn(async (_payload?: unknown) => undefined);
const findPublicPostReferenceByIdOrGenerationIdMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
const createUserClientMock = vi.fn();

vi.mock('@/lib/post-share-events', () => ({
  recordPostShareEvent: (payload: unknown) => recordPostShareEventMock(payload),
}));

vi.mock('@/lib/posts-server', () => ({
  findPublicPostReferenceByIdOrGenerationId: (id: string) =>
    findPublicPostReferenceByIdOrGenerationIdMock(id),
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
}));

describe('/api/showcase/share route', () => {
  beforeEach(() => {
    vi.resetModules();
    recordPostShareEventMock.mockClear();
    findPublicPostReferenceByIdOrGenerationIdMock.mockReset();
    createUserClientMock.mockReset();
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
        })),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records share clicks for public posts', async () => {
    findPublicPostReferenceByIdOrGenerationIdMock.mockResolvedValue({
      id: 'post-1',
      generation_id: 'gen-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'ugc_copy',
    });

    const { POST } = await import('@/app/api/showcase/share/route');
    const response = await POST(
      new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          generationId: 'gen-1',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(recordPostShareEventMock).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_click',
      sourceSurface: 'showcase',
      channel: 'copy-link',
      actorUserId: 'user-1',
    });
  });

  it('rejects private or missing posts', async () => {
    findPublicPostReferenceByIdOrGenerationIdMock.mockResolvedValue(null);

    const { POST } = await import('@/app/api/showcase/share/route');
    const response = await POST(
      new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          postId: 'post-2',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(404);
    expect(data.error).toContain('public creations');
    expect(recordPostShareEventMock).not.toHaveBeenCalled();
  });
});
