import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows = [
  {
    id: 'canvas-1',
    title: 'Workflow canvas',
    updated_at: '2026-03-24T11:00:00.000Z',
    revision: 2,
  },
];

function createSupabaseMock() {
  return {
    from(table: string) {
      if (table !== 'workflow_canvases') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          const query = {
            eq() {
              return query;
            },
            async order() {
              return {
                data: rows,
                error: null,
              };
            },
          };

          return query;
        },
      };
    },
  };
}

const authenticateRequestMock = vi.fn(async () => ({
  userId: 'user-1',
  supabase: createSupabaseMock(),
}));

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: (..._args: unknown[]) => authenticateRequestMock(),
}));

describe('/api/workflow-canvases GET', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns sidebar metadata without full graph payloads', async () => {
    const { GET } = await import('@/app/api/workflow-canvases/route');
    const response = await GET(new Request('http://localhost/api/workflow-canvases') as never);

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.canvases).toEqual(rows);
    expect(data.canvases[0]).not.toHaveProperty('graph');
  });
});
