import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

import { createStarterGraph } from '@/lib/workflow-canvas';

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createServiceClient: vi.fn(),
  patchWorkflowCanvas: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: (...args: unknown[]) => mocks.authenticateRequest(...args),
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

vi.mock('@/app/api/workflow-canvases/[id]/route', () => ({
  PATCH: (...args: unknown[]) => mocks.patchWorkflowCanvas(...args),
}));

type AssistantMessageRow = {
  id: string;
  canvas_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  proposal_id: string | null;
  created_at: string;
};

type AssistantProposalRow = {
  id: string;
  canvas_id: string;
  user_id: string;
  base_revision: number;
  status: 'ready' | 'applied' | 'discarded';
  summary: string;
  diff: {
    regionId: string;
    nodes: { added: unknown[]; changed: unknown[]; removed: unknown[] };
    edges: { added: number; removed: number };
  };
  proposed_graph: ReturnType<typeof createStarterGraph>;
  created_at: string;
  applied_at: string | null;
  discarded_at: string | null;
};

const canvasRow = {
  id: 'canvas-1',
  user_id: 'user-1',
  title: 'Workflow canvas',
  graph: createStarterGraph(),
  created_at: '2026-04-16T08:00:00.000Z',
  updated_at: '2026-04-16T08:00:00.000Z',
  revision: 4,
  status: 'draft',
  published_at: null,
};

let assistantMessages: AssistantMessageRow[] = [];
let assistantProposals: AssistantProposalRow[] = [];
let simulateMissingAssistantSchema = false;
let remainingCredits = 94;
let usageEventUpdates: Array<Record<string, unknown>> = [];
let adminRpcCalls: string[] = [];

function createWorkflowSupabaseMock() {
  return {
    from(table: string) {
      if (table === 'workflow_canvases') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              async maybeSingle() {
                if (filters.id === canvasRow.id && filters.user_id === canvasRow.user_id) {
                  return { data: { ...canvasRow }, error: null };
                }

                return { data: null, error: { message: 'not found' } };
              },
              async single() {
                if (filters.id === canvasRow.id && filters.user_id === canvasRow.user_id) {
                  return { data: { ...canvasRow }, error: null };
                }

                return { data: null, error: { message: 'not found' } };
              },
            };

            return query;
          },
        };
      }

      if (table === 'workflow_canvas_assistant_messages') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              order() {
                if (simulateMissingAssistantSchema) {
                  return Promise.resolve({
                    data: null,
                    error: { code: '42P01', message: 'relation "workflow_canvas_assistant_messages" does not exist' },
                  });
                }

                const rows = assistantMessages.filter((row) => (
                  (filters.canvas_id === undefined || row.canvas_id === filters.canvas_id) &&
                  (filters.user_id === undefined || row.user_id === filters.user_id)
                ));

                return Promise.resolve({ data: rows, error: null });
              },
            };

            return query;
          },
          insert(payload: Array<Record<string, unknown>>) {
            return {
              select() {
                return {
                  order() {
                    const inserted = payload.map((row, index) => ({
                      id: `msg-${assistantMessages.length + index + 1}`,
                      canvas_id: String(row.canvas_id),
                      user_id: String(row.user_id),
                      role: row.role === 'assistant' ? 'assistant' : 'user',
                      content: String(row.content ?? ''),
                      proposal_id: typeof row.proposal_id === 'string' ? row.proposal_id : null,
                      created_at: `2026-04-16T08:10:0${index}.000Z`,
                    })) as AssistantMessageRow[];

                    assistantMessages = [...assistantMessages, ...inserted];
                    return Promise.resolve({ data: inserted, error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'workflow_canvas_assistant_proposals') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            let excludedStatus: string | null = null;
            const getFilteredRows = () => assistantProposals
              .filter((row) => (
                (filters.canvas_id === undefined || row.canvas_id === filters.canvas_id) &&
                (filters.user_id === undefined || row.user_id === filters.user_id) &&
                (filters.id === undefined || row.id === filters.id) &&
                (excludedStatus === null || row.status !== excludedStatus)
              ))
              .sort((left, right) => right.created_at.localeCompare(left.created_at));
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              neq(column: string, value: unknown) {
                if (column === 'status') {
                  excludedStatus = String(value);
                }
                return query;
              },
              async limit(count: number) {
                if (simulateMissingAssistantSchema) {
                  return {
                    data: null,
                    error: { code: '42P01', message: 'relation "workflow_canvas_assistant_proposals" does not exist' },
                  };
                }

                return {
                  data: getFilteredRows().slice(0, count),
                  error: null,
                };
              },
              order() {
                const rows = getFilteredRows();

                return {
                  async limit(count: number) {
                    return { data: rows.slice(0, count), error: null };
                  },
                  async maybeSingle() {
                    return { data: rows[0] ?? null, error: null };
                  },
                };
              },
              async maybeSingle() {
                const row = assistantProposals.find((candidate) => (
                  (filters.id === undefined || candidate.id === filters.id) &&
                  (filters.canvas_id === undefined || candidate.canvas_id === filters.canvas_id) &&
                  (filters.user_id === undefined || candidate.user_id === filters.user_id)
                ));

                return { data: row ?? null, error: null };
              },
            };

            return query;
          },
          update(values: Record<string, unknown>) {
            const filters: Record<string, unknown> = {};
            const executeUpdate = async () => {
              assistantProposals = assistantProposals.map((proposal) => {
                const matches =
                  (filters.id === undefined || proposal.id === filters.id) &&
                  (filters.canvas_id === undefined || proposal.canvas_id === filters.canvas_id) &&
                  (filters.user_id === undefined || proposal.user_id === filters.user_id) &&
                  (filters.status === undefined || proposal.status === filters.status);

                return matches
                  ? {
                      ...proposal,
                      ...values,
                    }
                  : proposal;
              });

              return { error: null };
            };

            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              then<TResult1 = { error: null }, TResult2 = never>(
                onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
              ) {
                return executeUpdate().then(onfulfilled ?? undefined, onrejected ?? undefined);
              },
            };

            return query;
          },
          insert(payload: Record<string, unknown>) {
            return {
              select() {
                return {
                  async single() {
                    const inserted: AssistantProposalRow = {
                      id: 'proposal-new',
                      canvas_id: String(payload.canvas_id),
                      user_id: String(payload.user_id),
                      base_revision: Number(payload.base_revision ?? 0),
                      status: 'ready',
                      summary: String(payload.summary ?? ''),
                      diff: payload.diff as AssistantProposalRow['diff'],
                      proposed_graph: payload.proposed_graph as AssistantProposalRow['proposed_graph'],
                      created_at: '2026-04-16T08:10:00.000Z',
                      applied_at: null,
                      discarded_at: null,
                    };

                    assistantProposals = [inserted, ...assistantProposals];
                    return { data: inserted, error: null };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

function createAdminSupabaseMock() {
  return {
    rpc(fn: string) {
      adminRpcCalls.push(fn);
      if (fn === 'deduct_credits') {
        return Promise.resolve({ data: remainingCredits, error: null });
      }

      if (fn === 'refund_ai_usage_event' || fn === 'refund_credits') {
        return Promise.resolve({ data: true, error: null });
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    },
    from(table: string) {
      if (table !== 'ai_usage_events') {
        throw new Error(`Unexpected service table: ${table}`);
      }

      return {
        insert() {
          return {
            select() {
              return {
                async single() {
                  return {
                    data: { id: 'usage-1' },
                    error: null,
                  };
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          usageEventUpdates.push(values);
          return {
            async eq() {
              return { error: null };
            },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  assistantMessages = [];
  assistantProposals = [{
    id: 'proposal-1',
    canvas_id: canvasRow.id,
    user_id: canvasRow.user_id,
    base_revision: canvasRow.revision,
    status: 'ready',
    summary: 'Initial assistant proposal',
    diff: {
      regionId: 'assistant-region-1',
      nodes: { added: [], changed: [], removed: [] },
      edges: { added: 0, removed: 0 },
    },
    proposed_graph: createStarterGraph(),
    created_at: '2026-04-16T08:05:00.000Z',
    applied_at: null,
    discarded_at: null,
  }];
  simulateMissingAssistantSchema = false;
  remainingCredits = 94;
  usageEventUpdates = [];
  adminRpcCalls = [];
  mocks.authenticateRequest.mockResolvedValue({
    userId: canvasRow.user_id,
    supabase: createWorkflowSupabaseMock(),
  });
  mocks.createServiceClient.mockReturnValue(createAdminSupabaseMock());
  mocks.patchWorkflowCanvas.mockResolvedValue(NextResponse.json({
    canvas: {
      ...canvasRow,
      graph: createStarterGraph(),
      revision: canvasRow.revision + 1,
    },
  }));
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: `\`\`\`json
{"title":"Lightning transformation","assistantReply":"I built a transformation workflow.","changeSummary":"Added a lightning transformation workflow.","creativeStrategy":"Keep the same hero throughout.","narrative":"Before frame into powered-up reveal.","voiceover":"She takes the hit and transforms.","assetSlots":[{"slotKey":"hero-reference","kind":"image","label":"Hero reference","purpose":"Identity anchor","required":true},{"slotKey":"before-frame","kind":"image","label":"Before frame","purpose":"Before look","required":true},{"slotKey":"after-frame","kind":"image","label":"After frame","purpose":"After look","required":true}],"shots":[{"shotKey":"transform","title":"Transformation shot","purpose":"Main beat","beat":"Lightning strike","visualPrompt":"Before image prompt","videoPrompt":"Lightning strike transformation","motionPrompt":"Motion polish","duration":6,"startSlotKey":"before-frame","endSlotKey":"after-frame","referenceImageSlotKeys":["hero-reference"],"referenceVideoSlotKeys":[],"referenceAudioSlotKeys":[]}],"deliveryPlan":{"primaryModel":"seedance-1.5-pro","stillImageModel":"nano-banana-pro","motionModel":"kling-3.0","aspectRatio":"9:16"}}
\`\`\``,
        },
      }],
    }),
  });
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('workflow assistant routes', () => {
  it('returns empty assistant state when the assistant tables are missing', async () => {
    simulateMissingAssistantSchema = true;

    const { GET } = await import('@/app/api/workflow-canvases/[id]/assistant/route');
    const response = await GET(
      new Request('http://localhost/api/workflow-canvases/canvas-1/assistant') as never,
      { params: Promise.resolve({ id: canvasRow.id }) }
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toEqual({
      availability: 'setup_required',
      messages: [],
      proposal: null,
      setupMessage: 'Workflow assistant database tables are missing. Run migration 20260416120000_workflow_canvas_assistant.sql.',
      code: 'assistant_schema_missing',
      error: 'Workflow assistant database tables are missing. Run migration 20260416120000_workflow_canvas_assistant.sql.',
    });
  });

  it('returns setup-required before charging credits when the assistant tables are missing', async () => {
    simulateMissingAssistantSchema = true;

    const { POST } = await import('@/app/api/workflow-canvases/[id]/assistant/messages/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Create a before and after transformation using Seedance 2.0.',
        }),
      }) as never,
      { params: Promise.resolve({ id: canvasRow.id }) }
    );

    const data = await response.json();
    expect(response.status).toBe(503);
    expect(data.code).toBe('assistant_schema_missing');
    expect(data.error).toBe('Workflow assistant database tables are missing. Run migration 20260416120000_workflow_canvas_assistant.sql.');
    expect(adminRpcCalls).not.toContain('deduct_credits');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('creates a new assistant proposal from a chat message', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/assistant/messages/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Create a before and after lightning transformation workflow.',
        }),
      }) as never,
      { params: Promise.resolve({ id: canvasRow.id }) }
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.remainingCredits).toBe(94);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe('user');
    expect(data.messages[1].role).toBe('assistant');
    expect(data.proposal.summary).toBe('Added a lightning transformation workflow.');
    expect(data.proposal.proposed_graph.nodes.some((node: { data: { managed?: boolean } }) => node.data.managed)).toBe(true);
    expect(assistantProposals[0].status).toBe('ready');
    expect(usageEventUpdates.some((update) => update.status === 'succeeded')).toBe(true);
  });

  it('marks a proposal discarded when apply hits a stale canvas revision', async () => {
    mocks.patchWorkflowCanvas.mockResolvedValue(NextResponse.json({
      error: 'Workflow canvas has newer changes.',
      canvas: {
        ...canvasRow,
        revision: canvasRow.revision + 2,
      },
    }, { status: 409 }));

    const { POST } = await import('@/app/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/apply/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/apply', {
        method: 'POST',
      }) as never,
      { params: Promise.resolve({ id: canvasRow.id, proposalId: 'proposal-1' }) }
    );

    const data = await response.json();
    expect(response.status).toBe(409);
    expect(data.proposal.status).toBe('discarded');
    expect(assistantProposals[0].status).toBe('discarded');
  });

  it('discards an assistant proposal without mutating the live canvas', async () => {
    const { POST } = await import('@/app/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/discard/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/assistant/proposals/proposal-1/discard', {
        method: 'POST',
      }) as never,
      { params: Promise.resolve({ id: canvasRow.id, proposalId: 'proposal-1' }) }
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.proposal.status).toBe('discarded');
    expect(assistantProposals[0].status).toBe('discarded');
  });
});
