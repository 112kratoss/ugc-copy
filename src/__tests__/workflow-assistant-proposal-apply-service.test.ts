import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createStarterGraph } from '@/lib/workflow-canvas';
import { applyWorkflowAssistantProposalForRoute } from '@/lib/workflow-assistant-proposal-apply-service';

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

function readyProposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 'proposal-1',
    canvas_id: 'canvas-1',
    user_id: 'user-1',
    base_revision: 4,
    status: 'ready',
    summary: 'Apply a cleaner image generation branch.',
    diff: {
      regionId: 'region-1',
      nodes: { added: [], changed: [], removed: [] },
      edges: { added: 0, removed: 0 },
    },
    proposed_graph: createStarterGraph(),
    created_at: '2026-06-22T10:00:00.000Z',
    applied_at: null,
    discarded_at: null,
    ...overrides,
  };
}

function canvasRow(revision = 4) {
  return {
    id: 'canvas-1',
    user_id: 'user-1',
    title: 'Launch workflow',
    graph: createStarterGraph(),
    viewport: { x: 0, y: 0, zoom: 1 },
    revision,
    status: 'draft',
    published_at: null,
    created_at: '2026-06-22T09:00:00.000Z',
    updated_at: '2026-06-22T09:30:00.000Z',
  };
}

function createSupabaseMock({
  proposal = readyProposal(),
  canvas = canvasRow(),
  missingSchema = false,
  rpcData,
  rpcError = null,
}: {
  proposal?: ProposalRow | null;
  canvas?: ReturnType<typeof canvasRow> | null;
  missingSchema?: boolean;
  rpcData?: Record<string, unknown> | null;
  rpcError?: Record<string, unknown> | null;
} = {}) {
  const defaultRpcData = {
    outcome: 'applied',
    canvas: canvasRow(5),
    proposal: readyProposal({
      status: 'applied',
      applied_at: '2026-06-22T10:05:00.000Z',
    }),
  };
  const rpc = vi.fn(async () => ({
    data: rpcData === undefined ? defaultRpcData : rpcData,
    error: rpcError,
  }));

  const client = {
    from(table: string) {
      if (table !== 'workflow_canvas_assistant_proposals' && table !== 'workflow_canvases') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          const filters: Record<string, unknown> = {};
          const query = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return query;
            },
            async maybeSingle() {
              if (table === 'workflow_canvas_assistant_proposals' && missingSchema) {
                return {
                  data: null,
                  error: { code: '42P01', message: 'workflow_canvas_assistant_proposals missing' },
                };
              }

              const row = table === 'workflow_canvas_assistant_proposals' ? proposal : canvas;
              const matches = row && Object.entries(filters).every(([column, value]) => (
                (row as unknown as Record<string, unknown>)[column] === value
              ));
              return { data: matches ? { ...row } : null, error: null };
            },
          };
          return query;
        },
      };
    },
    rpc,
  };

  return { client: client as unknown as SupabaseClient, rpc };
}

describe('applyWorkflowAssistantProposalForRoute', () => {
  it('applies the merged graph and proposal state through one database RPC', async () => {
    const supabase = createSupabaseMock();

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        canvas: expect.objectContaining({ id: 'canvas-1', revision: 5 }),
        proposal: expect.objectContaining({
          id: 'proposal-1',
          status: 'applied',
          applied_at: '2026-06-22T10:05:00.000Z',
        }),
      },
    });
    expect(supabase.rpc).toHaveBeenCalledWith('apply_workflow_canvas_assistant_proposal', {
      p_canvas_id: 'canvas-1',
      p_proposal_id: 'proposal-1',
      p_merged_graph: expect.objectContaining({ nodes: expect.any(Array), edges: expect.any(Array) }),
    });
  });

  it('returns the atomic conflict result when the canvas revision changed', async () => {
    const conflictProposal = readyProposal({
      status: 'discarded',
      discarded_at: '2026-06-22T10:06:00.000Z',
    });
    const supabase = createSupabaseMock({
      rpcData: {
        outcome: 'conflict',
        canvas: canvasRow(8),
        proposal: conflictProposal,
      },
    });

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'Workflow canvas has newer changes.',
        canvas: expect.objectContaining({ revision: 8 }),
        proposal: expect.objectContaining({ status: 'discarded' }),
      },
    });
  });

  it('rejects non-ready proposals without invoking the mutation RPC', async () => {
    const supabase = createSupabaseMock({
      proposal: readyProposal({ status: 'applied', applied_at: '2026-06-22T10:02:00.000Z' }),
    });

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'Only ready proposals can be applied.' },
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('returns setup-required when the assistant schema or atomic RPC is missing', async () => {
    const missingTable = createSupabaseMock({ missingSchema: true });
    const missingFunction = createSupabaseMock({
      rpcError: {
        code: 'PGRST202',
        message: 'Could not find public.apply_workflow_canvas_assistant_proposal',
      },
    });

    for (const supabase of [missingTable, missingFunction]) {
      const result = await applyWorkflowAssistantProposalForRoute({
        canvasId: 'canvas-1',
        proposalId: 'proposal-1',
        userId: 'user-1',
        supabase: supabase.client,
      });
      expect(result).toMatchObject({
        ok: false,
        status: 503,
        body: { availability: 'setup_required', code: 'assistant_schema_missing' },
      });
    }
  });

  it('never reports success when the atomic persistence call fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const supabase = createSupabaseMock({
      rpcError: { code: 'XX000', message: 'database write failed' },
    });

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to apply assistant proposal.' },
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
