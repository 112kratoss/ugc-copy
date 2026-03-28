import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordGenerationShareEventMock = vi.fn(async () => undefined);
const createUserClientMock = vi.fn();
const maybeSingleMock = vi.fn();

vi.mock('@/lib/generation-share-events', () => ({
  recordGenerationShareEvent: (payload: unknown) => recordGenerationShareEventMock(payload),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'generations') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return maybeSingleMock();
                },
              };
            },
          };
        },
      };
    },
  }),
  createUserClient: (request: Request) => createUserClientMock(request),
}));

describe('/api/showcase/share route', () => {
  beforeEach(() => {
    vi.resetModules();
    recordGenerationShareEventMock.mockClear();
    maybeSingleMock.mockReset();
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

  it('records share clicks for public creations', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: 'gen-1', is_public: true },
      error: null,
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
    expect(recordGenerationShareEventMock).toHaveBeenCalledWith({
      generationId: 'gen-1',
      eventType: 'share_click',
      sourceSurface: 'showcase',
      channel: 'copy-link',
      actorUserId: 'user-1',
    });
  });

  it('rejects private creations', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: 'gen-2', is_public: false },
      error: null,
    });

    const { POST } = await import('@/app/api/showcase/share/route');
    const response = await POST(
      new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          generationId: 'gen-2',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(404);
    expect(data.error).toContain('public creations');
    expect(recordGenerationShareEventMock).not.toHaveBeenCalled();
  });
});
