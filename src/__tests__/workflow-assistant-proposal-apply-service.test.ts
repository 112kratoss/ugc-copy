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

function createSupabaseMock({
  proposal = readyProposal(),
  missingSchema = false,
}: {
  proposal?: ProposalRow | null;
  missingSchema?: boolean;
} = {}) {
  const updates: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      if (table !== 'workflow_canvas_assistant_proposals') {
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
              if (missingSchema) {
                return {
                  data: null,
                  error: { code: '42P01', message: 'workflow_canvas_assistant_proposals missing' },
                };
              }

              const matches =
                proposal &&
                filters.id === proposal.id &&
                filters.canvas_id === proposal.canvas_id &&
                filters.user_id === proposal.user_id;

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
            eq() {
              return query;
            },
            then(resolve: (value: { error: null }) => void) {
              updates.push(payload);
              resolve({ error: null });
            },
          };
          return query;
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    updates,
  };
}

describe('applyWorkflowAssistantProposalForRoute', () => {
  it('applies a ready proposal and marks it applied after the canvas patch succeeds', async () => {
    const supabase = createSupabaseMock();
    const applyCanvasPatch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { canvas: { id: 'canvas-1', revision: 5 } },
    }));

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
      applyCanvasPatch,
      now: () => '2026-06-22T10:05:00.000Z',
    });

    expect(result).toEqual({
      ok: true,
      body: {
        canvas: { id: 'canvas-1', revision: 5 },
        proposal: expect.objectContaining({
          id: 'proposal-1',
          status: 'applied',
          applied_at: '2026-06-22T10:05:00.000Z',
        }),
      },
    });
    expect(applyCanvasPatch).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      graph: expect.objectContaining({ nodes: expect.any(Array) }),
      baseRevision: 4,
    });
    expect(supabase.updates).toEqual([
      {
        status: 'applied',
        applied_at: '2026-06-22T10:05:00.000Z',
      },
    ]);
  });

  it('discards the proposal when the canvas patch reports a stale revision', async () => {
    const supabase = createSupabaseMock();

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
      applyCanvasPatch: vi.fn(async () => ({
        ok: false,
        status: 409,
        body: {
          error: 'Workflow canvas has newer changes.',
          canvas: { id: 'canvas-1', revision: 8 },
        },
      })),
      now: () => '2026-06-22T10:06:00.000Z',
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'Workflow canvas has newer changes.',
        canvas: { id: 'canvas-1', revision: 8 },
        proposal: expect.objectContaining({
          id: 'proposal-1',
          status: 'discarded',
          discarded_at: '2026-06-22T10:06:00.000Z',
        }),
      },
    });
    expect(supabase.updates).toEqual([
      {
        status: 'discarded',
        discarded_at: '2026-06-22T10:06:00.000Z',
      },
    ]);
  });

  it('rejects non-ready proposals without patching the canvas', async () => {
    const supabase = createSupabaseMock({
      proposal: readyProposal({ status: 'applied', applied_at: '2026-06-22T10:02:00.000Z' }),
    });
    const applyCanvasPatch = vi.fn();

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
      applyCanvasPatch,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: { error: 'Only ready proposals can be applied.' },
    });
    expect(applyCanvasPatch).not.toHaveBeenCalled();
  });

  it('returns setup-required when the assistant proposal schema is missing', async () => {
    const supabase = createSupabaseMock({ missingSchema: true });

    const result = await applyWorkflowAssistantProposalForRoute({
      canvasId: 'canvas-1',
      proposalId: 'proposal-1',
      userId: 'user-1',
      supabase: supabase.client,
      applyCanvasPatch: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      availability: 'setup_required',
      code: 'assistant_schema_missing',
    });
  });
});
