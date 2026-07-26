import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { discardWorkflowAssistantProposalForRoute } from '@/lib/workflow-assistant-proposal-discard-service';
import { createStarterGraph } from '@/lib/workflow-canvas';

type ProposalRow = {
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

function proposalRow(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 'proposal-1',
    canvas_id: 'canvas-1',
    user_id: 'user-1',
    base_revision: 4,
    status: 'ready',
    summary: 'Remove the rough draft branch.',
    diff: {
      regionId: 'region-1',
      nodes: { added: [], changed: [], removed: [] },
      edges: { added: 0, removed: 0 },
    },
    proposed_graph: createStarterGraph(),
    created_at: '2026-06-23T10:00:00.000Z',
    applied_at: null,
    discarded_at: null,
    ...overrides,
  };
}

function createSupabaseMock({
  proposal = proposalRow(),
  missingSchemaOnSelect = false,
  missingSchemaOnUpdate = false,
}: {
  proposal?: ProposalRow | null;
  missingSchemaOnSelect?: boolean;
  missingSchemaOnUpdate?: boolean;
} = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const filters: Array<{ phase: 'select' | 'update'; column: string; value: unknown }> = [];

  const client = {
    from(table: string) {
      if (table !== 'workflow_canvas_assistant_proposals') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          const selectFilters: Record<string, unknown> = {};
          const query = {
            eq(column: string, value: unknown) {
              selectFilters[column] = value;
              filters.push({ phase: 'select', column, value });
              return query;
            },
            async maybeSingle() {
              if (missingSchemaOnSelect) {
                return {
                  data: null,
                  error: { code: '42P01', message: 'workflow_canvas_assistant_proposals missing' },
                };
              }

              const matches =
                proposal &&
                selectFilters.id === proposal.id &&
                selectFilters.canvas_id === proposal.canvas_id &&
                selectFilters.user_id === proposal.user_id;

              return {
                data: matches ? { ...proposal } : null,
                error: null,
              };
            },
          };
          return query;
        },
        update(payload: Record<string, unknown>) {
          const query = {
            eq(column: string, value: unknown) {
              filters.push({ phase: 'update', column, value });
              return query;
            },
            then(resolve: (value: { error: null | { code: string; message: string } }) => void) {
              updates.push(payload);
              resolve({
                error: missingSchemaOnUpdate
                  ? { code: '42P01', message: 'workflow_canvas_assistant_proposals missing' }
                  : null,
              });
            },
          };
          return query;
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    filters,
    updates,
  };
}

describe('discardWorkflowAssistantProposalForRoute', () => {
  it('loads the owned proposal and marks it discarded with a deterministic timestamp', async () => {
    const supabase = createSupabaseMock();

    const result = await discardWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
      now: () => '2026-06-23T10:05:00.000Z',
    });

    expect(result).toEqual({
      ok: true,
      body: {
        proposal: expect.objectContaining({
          id: 'proposal-1',
          status: 'discarded',
          discarded_at: '2026-06-23T10:05:00.000Z',
        }),
      },
    });
    expect(supabase.updates).toEqual([
      {
        status: 'discarded',
        discarded_at: '2026-06-23T10:05:00.000Z',
      },
    ]);
    expect(supabase.filters).toEqual(expect.arrayContaining([
      { phase: 'select', column: 'id', value: 'proposal-1' },
      { phase: 'select', column: 'canvas_id', value: 'canvas-1' },
      { phase: 'select', column: 'user_id', value: 'user-1' },
      { phase: 'update', column: 'id', value: 'proposal-1' },
      { phase: 'update', column: 'user_id', value: 'user-1' },
    ]));
  });

  it('returns not found without updating when the proposal is missing', async () => {
    const supabase = createSupabaseMock({ proposal: null });

    const result = await discardWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Workflow assistant proposal not found.' },
    });
    expect(supabase.updates).toEqual([]);
  });

  it('returns setup-required when the assistant proposal schema is missing', async () => {
    const supabase = createSupabaseMock({ missingSchemaOnSelect: true });

    const result = await discardWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected setup-required response');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      availability: 'setup_required',
      code: 'assistant_schema_missing',
    });
  });

  it('returns setup-required when the discard update sees a missing assistant schema', async () => {
    const supabase = createSupabaseMock({ missingSchemaOnUpdate: true });

    const result = await discardWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
      now: () => '2026-06-23T10:05:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected setup-required response');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      availability: 'setup_required',
      code: 'assistant_schema_missing',
    });
  });
});
