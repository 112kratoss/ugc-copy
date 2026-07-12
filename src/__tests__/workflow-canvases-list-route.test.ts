import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStarterGraph } from '@/lib/workflow-canvas';

const rows = [
  {
    id: 'canvas-1',
    title: 'Workflow canvas',
    updated_at: '2026-03-24T11:00:00.000Z',
    revision: 2,
    status: 'draft',
    published_at: null,
  },
];

let shouldFallbackToLegacyList = false;
let shouldFallbackToLegacyInsert = false;
let insertedPayloads: Array<Record<string, unknown>> = [];
const rateLimitRpcMock = vi.fn();

function createSupabaseMock() {
  return {
    from(table: string) {
      if (table === 'workflow_canvases') {
        return {
          select(columns?: string) {
            const query = {
              eq() {
                return query;
              },
              async order() {
                if (shouldFallbackToLegacyList && columns?.includes('status')) {
                  return {
                    data: null,
                    error: { code: '42703', message: 'column workflow_canvases.status does not exist' },
                  };
                }

                if (columns?.includes('status')) {
                  return {
                    data: rows,
                    error: null,
                  };
                }

                return {
                  data: rows.map((row) => ({
                    id: row.id,
                    title: row.title,
                    updated_at: row.updated_at,
                    revision: row.revision,
                  })),
                  error: null,
                };
              },
            };

            return query;
          },
          insert(payload: Record<string, unknown>) {
            insertedPayloads.push(payload);

            return {
              select(columns?: string) {
                return {
                  async single() {
                    if (shouldFallbackToLegacyInsert && 'status' in payload) {
                      return {
                        data: null,
                        error: { code: '42703', message: 'column "status" of relation "workflow_canvases" does not exist' },
                      };
                    }

                    const baseRow = {
                      id: 'canvas-2',
                      title: String(payload.title ?? 'New workflow canvas'),
                      graph: createStarterGraph(),
                      created_at: '2026-03-24T11:02:00.000Z',
                      updated_at: '2026-03-24T11:02:00.000Z',
                      revision: 0,
                    };

                    if (columns?.includes('status')) {
                      return {
                        data: {
                          ...baseRow,
                          status: 'draft',
                          published_at: null,
                        },
                        error: null,
                      };
                    }

                    return {
                      data: baseRow,
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'workflow_canvas_history') {
        return {
          async insert() {
            return {
              error: shouldFallbackToLegacyInsert
                ? { code: '42P01', message: 'relation "workflow_canvas_history" does not exist' }
                : null,
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

const authenticateRequestMock = vi.fn(async () => ({
  userId: 'user-1',
  supabase: createSupabaseMock(),
}));

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: () => authenticateRequestMock(),
  createServiceClient: () => ({
    rpc: rateLimitRpcMock,
  }),
}));

describe('/api/workflow-canvases routes', () => {
  beforeEach(() => {
    vi.resetModules();
    shouldFallbackToLegacyList = false;
    shouldFallbackToLegacyInsert = false;
    insertedPayloads = [];
    rateLimitRpcMock.mockReset();
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 240,
        remaining: 239,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns sanitized library previews without full graph payloads', async () => {
    const { GET } = await import('@/app/api/workflow-canvases/route');
    const response = await GET(new Request('http://localhost/api/workflow-canvases') as never);

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.canvases).toEqual([{
      ...rows[0],
      preview: { nodes: [], edges: [], truncated: false },
      node_count: 0,
      connection_count: 0,
      output_kinds: [],
    }]);
    expect(data.canvases[0]).not.toHaveProperty('graph');
  });

  it('falls back to the legacy canvas list schema when lifecycle columns are missing', async () => {
    shouldFallbackToLegacyList = true;

    const { GET } = await import('@/app/api/workflow-canvases/route');
    const response = await GET(new Request('http://localhost/api/workflow-canvases') as never);

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.canvases).toEqual([{
      id: 'canvas-1',
      title: 'Workflow canvas',
      updated_at: '2026-03-24T11:00:00.000Z',
      revision: 2,
      status: 'draft',
      published_at: null,
      preview: { nodes: [], edges: [], truncated: false },
      node_count: 0,
      connection_count: 0,
      output_kinds: [],
    }]);
  });

  it('creates a canvas even when lifecycle columns and history table are missing', async () => {
    shouldFallbackToLegacyInsert = true;

    const { POST } = await import('@/app/api/workflow-canvases/route');
    const response = await POST(new Request('http://localhost/api/workflow-canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Fallback canvas', graph: createStarterGraph() }),
    }) as never);

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.canvas).toMatchObject({
      id: 'canvas-2',
      title: 'Fallback canvas',
      status: 'draft',
      published_at: null,
    });
    expect(insertedPayloads).toHaveLength(2);
    expect(insertedPayloads[0]).toHaveProperty('status', 'draft');
    expect(insertedPayloads[1]).not.toHaveProperty('status');
  });
});
