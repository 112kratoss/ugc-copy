import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { WORKFLOW_ASSISTANT_SETUP_ERROR_CODE } from '@/lib/workflow-assistant';
import { createStarterGraph } from '@/lib/workflow-canvas';
import { getWorkflowAssistantStateForRoute } from '@/lib/workflow-assistant-state-service';

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

function proposal(overrides: Partial<AssistantProposalRow> = {}): AssistantProposalRow {
  return {
    id: 'proposal-1',
    canvas_id: 'canvas-1',
    user_id: 'user-1',
    base_revision: 4,
    status: 'ready',
    summary: 'Improve the generation branch.',
    diff: {
      regionId: 'region-1',
      nodes: { added: [], changed: [], removed: [] },
      edges: { added: 0, removed: 0 },
    },
    proposed_graph: createStarterGraph(),
    created_at: '2026-06-23T10:04:00.000Z',
    applied_at: null,
    discarded_at: null,
    ...overrides,
  };
}

function createSupabaseMock({
  canvas = {
    id: 'canvas-1',
    user_id: 'user-1',
    title: 'Workflow canvas',
    graph: createStarterGraph(),
    created_at: '2026-06-23T10:00:00.000Z',
    updated_at: '2026-06-23T10:00:00.000Z',
    revision: 4,
    status: 'draft',
    published_at: null,
  },
  messages = [],
  proposals = [],
  missingMessagesSchema = false,
  missingProposalsSchema = false,
  messageError = null,
}: {
  canvas?: Record<string, unknown> | null;
  messages?: AssistantMessageRow[];
  proposals?: AssistantProposalRow[];
  missingMessagesSchema?: boolean;
  missingProposalsSchema?: boolean;
  messageError?: Record<string, unknown> | null;
} = {}) {
  const client = {
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
                const matches =
                  canvas &&
                  filters.id === canvas.id &&
                  filters.user_id === canvas.user_id;

                return { data: matches ? { ...canvas } : null, error: null };
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
              async order() {
                if (missingMessagesSchema) {
                  return {
                    data: null,
                    error: {
                      code: '42P01',
                      message: 'relation "workflow_canvas_assistant_messages" does not exist',
                    },
                  };
                }

                if (messageError) {
                  return { data: null, error: messageError };
                }

                return {
                  data: messages.filter((row) => (
                    row.canvas_id === filters.canvas_id &&
                    row.user_id === filters.user_id
                  )),
                  error: null,
                };
              },
            };
            return query;
          },
        };
      }

      if (table === 'workflow_canvas_assistant_proposals') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            let excludedStatus: string | null = null;
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
              order() {
                const ordered = proposals
                  .filter((row) => (
                    row.canvas_id === filters.canvas_id &&
                    row.user_id === filters.user_id &&
                    (excludedStatus === null || row.status !== excludedStatus)
                  ))
                  .sort((left, right) => right.created_at.localeCompare(left.created_at));

                return {
                  async limit(count: number) {
                    if (missingProposalsSchema) {
                      return {
                        data: null,
                        error: {
                          code: '42P01',
                          message: 'relation "workflow_canvas_assistant_proposals" does not exist',
                        },
                      };
                    }

                    return { data: ordered.slice(0, count), error: null };
                  },
                };
              },
            };
            return query;
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return client as unknown as SupabaseClient;
}

describe('getWorkflowAssistantStateForRoute', () => {
  it('loads normalized assistant messages and the latest non-discarded proposal', async () => {
    const result = await getWorkflowAssistantStateForRoute({
      canvasId: 'canvas-1',
      supabase: createSupabaseMock({
        messages: [
          {
            id: 'message-1',
            canvas_id: 'canvas-1',
            user_id: 'user-1',
            role: 'user',
            content: 'Make a video workflow.',
            proposal_id: null,
            created_at: '2026-06-23T10:01:00.000Z',
          },
          {
            id: 'message-2',
            canvas_id: 'canvas-1',
            user_id: 'user-1',
            role: 'assistant',
            content: 'I drafted the workflow.',
            proposal_id: 'proposal-2',
            created_at: '2026-06-23T10:02:00.000Z',
          },
        ],
        proposals: [
          proposal({
            id: 'proposal-1',
            summary: 'Discarded older proposal.',
            status: 'discarded',
            discarded_at: '2026-06-23T10:03:00.000Z',
            created_at: '2026-06-23T10:05:00.000Z',
          }),
          proposal({
            id: 'proposal-2',
            summary: 'Latest usable proposal.',
            created_at: '2026-06-23T10:04:00.000Z',
          }),
        ],
      }),
      userId: 'user-1',
    });

    expect(result).toEqual({
      ok: true,
      body: {
        availability: 'ready',
        setupMessage: null,
        messages: [
          expect.objectContaining({ id: 'message-1', role: 'user' }),
          expect.objectContaining({ id: 'message-2', role: 'assistant', proposal_id: 'proposal-2' }),
        ],
        proposal: expect.objectContaining({
          id: 'proposal-2',
          status: 'ready',
          summary: 'Latest usable proposal.',
        }),
      },
    });
  });

  it('preserves loaded messages when proposal storage is missing', async () => {
    const result = await getWorkflowAssistantStateForRoute({
      canvasId: 'canvas-1',
      supabase: createSupabaseMock({
        messages: [{
          id: 'message-1',
          canvas_id: 'canvas-1',
          user_id: 'user-1',
          role: 'user',
          content: 'Keep this draft chat.',
          proposal_id: null,
          created_at: '2026-06-23T10:01:00.000Z',
        }],
        missingProposalsSchema: true,
      }),
      userId: 'user-1',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      availability: 'setup_required',
      code: WORKFLOW_ASSISTANT_SETUP_ERROR_CODE,
      messages: [expect.objectContaining({ id: 'message-1', content: 'Keep this draft chat.' })],
    });
  });

  it('returns not found before assistant table reads when the canvas is not owned', async () => {
    const result = await getWorkflowAssistantStateForRoute({
      canvasId: 'canvas-2',
      supabase: createSupabaseMock({ canvas: null }),
      userId: 'user-1',
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Workflow canvas not found.' },
    });
  });

  it('maps unexpected assistant load failures to a stable route error', async () => {
    const logError = vi.fn();
    const result = await getWorkflowAssistantStateForRoute({
      canvasId: 'canvas-1',
      logError,
      supabase: createSupabaseMock({
        messageError: { code: 'PGRST500', message: 'database temporarily unavailable' },
      }),
      userId: 'user-1',
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to load workflow assistant state.' },
    });
    expect(logError).toHaveBeenCalledWith(
      'Failed to load workflow canvas assistant state:',
      expect.objectContaining({ code: 'PGRST500' }),
    );
  });
});
