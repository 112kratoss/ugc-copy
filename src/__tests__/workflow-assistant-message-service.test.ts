import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { WORKFLOW_ASSISTANT_SETUP_ERROR_CODE } from '@/lib/workflow-assistant';
import { createStarterGraph } from '@/lib/workflow-canvas';
import { createWorkflowAssistantMessageForRoute } from '@/lib/workflow-assistant-message-service';

function makeCanvasQuery() {
  const query = {
    eq() {
      return query;
    },
    async maybeSingle() {
      return {
        data: {
          id: 'canvas-1',
          user_id: 'user-1',
          title: 'Workflow canvas',
          graph: createStarterGraph(),
          created_at: '2026-06-22T10:00:00.000Z',
          updated_at: '2026-06-22T10:00:00.000Z',
          revision: 3,
          status: 'draft',
          published_at: null,
        },
        error: null,
      };
    },
  };
  return query;
}

function createUserSupabaseMock() {
  const client = {
    from(table: string) {
      if (table === 'workflow_canvases') {
        return {
          select() {
            return makeCanvasQuery();
          },
        };
      }

      if (table === 'workflow_canvas_assistant_messages') {
        return {
          select() {
            const query = {
              eq() {
                return query;
              },
              order() {
                return {
                  async limit() {
                    return {
                      data: null,
                      error: {
                        code: '42P01',
                        message: 'relation "workflow_canvas_assistant_messages" does not exist',
                      },
                    };
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

function createAdminSupabaseMock() {
  const rpcCalls: string[] = [];
  const client = {
    async rpc(fn: string) {
      rpcCalls.push(fn);
      return { data: null, error: null };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
  };
}

describe('createWorkflowAssistantMessageForRoute', () => {
  it('returns setup-required before rate limiting or charging when assistant tables are missing', async () => {
    const admin = createAdminSupabaseMock();
    const result = await createWorkflowAssistantMessageForRoute({
      adminSupabase: admin.client,
      body: { content: 'Create a before and after product workflow.' },
      canvasId: 'canvas-1',
      idempotencyKey: null,
      supabase: createUserSupabaseMock(),
      userId: 'user-1',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      code: WORKFLOW_ASSISTANT_SETUP_ERROR_CODE,
    });
    expect(admin.rpcCalls).toEqual([]);
  });
});
