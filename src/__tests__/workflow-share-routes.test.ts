import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

import {
  createStarterGraph,
  createWorkflowShareSnapshotGraph,
} from '@/lib/workflow-canvas';

const SHARE_ID = '11111111-1111-4111-8111-111111111111';

let authenticateMode: 'authorized' | 'unauthorized' = 'authorized';
let allowCanvasLookup = true;
let insertedSharePayloads: Array<Record<string, unknown>> = [];
let insertedCanvasPayloads: Array<Record<string, unknown>> = [];
let shareImportCountUpdates: Array<Record<string, unknown>> = [];
const rateLimitRpcMock = vi.fn();

const sourceCanvas = {
  id: 'canvas-1',
  title: 'Workflow canvas',
  graph: createStarterGraph(),
  created_at: '2026-04-02T09:00:00.000Z',
  updated_at: '2026-04-02T09:00:00.000Z',
  revision: 3,
  status: 'draft',
  published_at: null,
};

const sharedSnapshot = createWorkflowShareSnapshotGraph(sourceCanvas.graph);
const shareRow = {
  id: SHARE_ID,
  owner_user_id: 'user-1',
  source_canvas_id: sourceCanvas.id,
  source_revision: sourceCanvas.revision,
  title: 'Shared workflow',
  graph: sharedSnapshot,
  node_count: sharedSnapshot.nodes.length,
  edge_count: sharedSnapshot.edges.length,
  import_count: 0,
  created_at: '2026-04-02T10:00:00.000Z',
};

function createServiceSupabaseMock() {
  return {
    rpc: rateLimitRpcMock,
    from(table: string) {
      if (table !== 'workflow_shares') {
        throw new Error(`Unexpected service table: ${table}`);
      }

      return {
        insert(payload: Record<string, unknown>) {
          insertedSharePayloads.push(payload);
          return {
            select() {
              return {
                async single() {
                  return {
                    data: {
                      id: SHARE_ID,
                      title: String(payload.title),
                      node_count: Number(payload.node_count ?? 0),
                      edge_count: Number(payload.edge_count ?? 0),
                      import_count: 0,
                      created_at: '2026-04-02T10:00:00.000Z',
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
        select() {
          const query = {
            eq() { return query; },
            async maybeSingle() {
              return { data: shareRow, error: null };
            },
          };
          return query;
        },
        update(payload: Record<string, unknown>) {
          shareImportCountUpdates.push(payload);

          return {
            async eq() {
              return {
                error: null,
              };
            },
          };
        },
      };
    },
  };
}

function createSupabaseMock() {
  return {
    from(table: string) {
      if (table === 'workflow_canvases') {
        return {
          select() {
            const query = {
              eq() {
                return query;
              },
              async single() {
                if (!allowCanvasLookup) {
                  return {
                    data: null,
                    error: { message: 'not found' },
                  };
                }

                return {
                  data: sourceCanvas,
                  error: null,
                };
              },
            };

            return query;
          },
          insert(payload: Record<string, unknown>) {
            insertedCanvasPayloads.push(payload);

            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: 'canvas-2',
                        title: String(payload.title),
                        graph: payload.graph,
                        created_at: '2026-04-02T10:05:00.000Z',
                        updated_at: '2026-04-02T10:05:00.000Z',
                        revision: 0,
                        status: 'draft',
                        published_at: null,
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

      if (table === 'workflow_shares') {
        return {
          insert(payload: Record<string, unknown>) {
            insertedSharePayloads.push(payload);

            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: SHARE_ID,
                        title: String(payload.title),
                        node_count: Number(payload.node_count ?? 0),
                        edge_count: Number(payload.edge_count ?? 0),
                        import_count: 0,
                        created_at: '2026-04-02T10:00:00.000Z',
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
          select() {
            const query = {
              eq() {
                return query;
              },
              async maybeSingle() {
                return {
                  data: shareRow,
                  error: null,
                };
              },
            };

            return query;
          },
        };
      }

      if (table === 'workflow_canvas_history') {
        return {
          async insert() {
            return {
              error: null,
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

const authenticateRequestMock = vi.fn(async () => {
  if (authenticateMode === 'unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return {
    userId: 'user-2',
    supabase: createSupabaseMock(),
  };
});

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: () => authenticateRequestMock(),
  createServiceClient: () => createServiceSupabaseMock(),
}));

describe('workflow share routes', () => {
  beforeEach(() => {
    vi.resetModules();
    authenticateMode = 'authorized';
    allowCanvasLookup = true;
    insertedSharePayloads = [];
    insertedCanvasPayloads = [];
    shareImportCountUpdates = [];
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

  it('creates a workflow share snapshot link from the owner canvas', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/share/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/share', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.share).toMatchObject({
      id: SHARE_ID,
      title: 'Workflow canvas',
      importPath: `/create-workflow?import=${SHARE_ID}`,
      importUrl: `http://localhost/create-workflow?import=${SHARE_ID}`,
    });
    expect(insertedSharePayloads[0]).toMatchObject({
      owner_user_id: 'user-2',
      source_canvas_id: 'canvas-1',
      source_revision: 3,
      title: 'Workflow canvas',
    });
  });

  it('returns not found when the authenticated owner cannot access the source canvas', async () => {
    allowCanvasLookup = false;

    const { POST } = await import('@/app/api/workflow-canvases/[id]/share/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/share', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    expect(response.status).toBe(404);
  });

  it('requires authentication for preview and import routes', async () => {
    authenticateMode = 'unauthorized';

    const { GET } = await import('@/app/api/workflow-shares/[shareId]/route');
    const previewResponse = await GET(
      new Request(`http://localhost/api/workflow-shares/${SHARE_ID}`) as never,
      { params: Promise.resolve({ shareId: SHARE_ID }) }
    );

    const { POST } = await import('@/app/api/workflow-shares/[shareId]/import/route');
    const importResponse = await POST(
      new Request(`http://localhost/api/workflow-shares/${SHARE_ID}/import`, { method: 'POST' }) as never,
      { params: Promise.resolve({ shareId: SHARE_ID }) }
    );

    expect(previewResponse.status).toBe(401);
    expect(importResponse.status).toBe(401);
  });

  it('imports a shared workflow into a new private draft without mutating the shared snapshot', async () => {
    const originalShareGraph = JSON.parse(JSON.stringify(shareRow.graph));

    const { POST } = await import('@/app/api/workflow-shares/[shareId]/import/route');
    const response = await POST(
      new Request(`http://localhost/api/workflow-shares/${SHARE_ID}/import`, { method: 'POST' }) as never,
      { params: Promise.resolve({ shareId: SHARE_ID }) }
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.canvas).toMatchObject({
      id: 'canvas-2',
      title: 'Copy of Shared workflow',
      status: 'draft',
      published_at: null,
    });
    expect(insertedCanvasPayloads[0]).toMatchObject({
      user_id: 'user-2',
      title: 'Copy of Shared workflow',
      status: 'draft',
    });
    expect(shareImportCountUpdates[0]).toMatchObject({
      import_count: 1,
    });
    expect(shareRow.graph).toEqual(originalShareGraph);
  });
});
