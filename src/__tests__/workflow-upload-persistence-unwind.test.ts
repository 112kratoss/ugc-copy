import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const uploadConsumptionMocks = vi.hoisted(() => ({
  abortPreparedWorkflowUploads: vi.fn(),
  consumePersistedWorkflowUploads: vi.fn(),
  prepareWorkflowUploadsForPersistence: vi.fn(),
}));

vi.mock('@/lib/workflow-upload-consumption', () => uploadConsumptionMocks);

import { createStarterGraph } from '@/lib/workflow-canvas';
import { createWorkflowCanvasForRoute } from '@/lib/workflow-canvas-collection-service';
import { patchWorkflowCanvasForRoute } from '@/lib/workflow-canvas-route-service';

const preparedLocations = [{
  bucket: 'generated_images' as const,
  storagePath: 'user-1/reference.png',
  consumptionClaim: {
    uploadId: '11111111-1111-4111-8111-111111111111',
    userId: 'user-1',
    leaseId: '22222222-2222-4222-8222-222222222222',
    disposition: 'preserve' as const,
  },
}];

function rateLimitClient() {
  return {
    rpc: vi.fn(async () => ({
      data: {
        allowed: true,
        limit: 240,
        remaining: 239,
        retryAfterSeconds: 0,
        resetAt: '2026-08-20T12:00:00.000Z',
      },
      error: null,
    })),
  };
}

function ownedCanvas() {
  return {
    id: 'canvas-1',
    user_id: 'user-1',
    title: 'Original workflow',
    graph: createStarterGraph(),
    created_at: '2026-08-20T10:00:00.000Z',
    updated_at: '2026-08-20T10:00:00.000Z',
    revision: 4,
    status: 'draft',
    published_at: null,
  };
}

describe('workflow upload lease persistence unwind', () => {
  beforeEach(() => {
    uploadConsumptionMocks.abortPreparedWorkflowUploads.mockReset();
    uploadConsumptionMocks.abortPreparedWorkflowUploads.mockResolvedValue(undefined);
    uploadConsumptionMocks.consumePersistedWorkflowUploads.mockReset();
    uploadConsumptionMocks.consumePersistedWorkflowUploads.mockResolvedValue({ ok: true });
    uploadConsumptionMocks.prepareWorkflowUploadsForPersistence.mockReset();
    uploadConsumptionMocks.prepareWorkflowUploadsForPersistence.mockResolvedValue({
      ok: true,
      locations: preparedLocations,
    });
  });

  it('keeps claimed uploads quarantined when canvas creation has an ambiguous transport outcome', async () => {
    const insertFailure = new Error('database transport unavailable');
    const supabase = {
      from(table: string) {
        if (table !== 'workflow_canvases') throw new Error(`Unexpected table: ${table}`);
        return {
          insert() {
            return {
              select() {
                return { single: vi.fn().mockRejectedValue(insertFailure) };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;
    const uploadClient = { kind: 'service-role' } as unknown as SupabaseClient;

    await expect(createWorkflowCanvasForRoute({
      supabase,
      uploadClient,
      rateLimitClient: rateLimitClient(),
      userId: 'user-1',
      readBody: async () => ({ title: 'New workflow', graph: createStarterGraph() }),
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to create workflow canvas.' },
    });

    expect(uploadConsumptionMocks.abortPreparedWorkflowUploads).not.toHaveBeenCalled();
    expect(uploadConsumptionMocks.consumePersistedWorkflowUploads).not.toHaveBeenCalled();
  });

  it('keeps claimed uploads quarantined when a canvas update has an ambiguous transport outcome', async () => {
    const canvas = ownedCanvas();
    const selectQuery = {
      eq() { return selectQuery; },
      async single() { return { data: canvas, error: null }; },
    };
    const updateQuery = {
      eq() { return updateQuery; },
      select() { return updateQuery; },
      maybeSingle: vi.fn().mockRejectedValue(new Error('update transport unavailable')),
    };
    const supabase = {
      from(table: string) {
        if (table !== 'workflow_canvases') throw new Error(`Unexpected table: ${table}`);
        return {
          select() { return selectQuery; },
          update() { return updateQuery; },
        };
      },
    } as unknown as SupabaseClient;
    const uploadClient = { kind: 'service-role' } as unknown as SupabaseClient;

    await expect(patchWorkflowCanvasForRoute({
      body: {
        title: 'Updated workflow',
        graph: createStarterGraph(),
        baseRevision: 4,
      },
      canvasId: canvas.id,
      supabase,
      uploadClient,
      userId: canvas.user_id,
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to update workflow canvas.' },
    });

    expect(uploadConsumptionMocks.abortPreparedWorkflowUploads).not.toHaveBeenCalled();
    expect(uploadConsumptionMocks.consumePersistedWorkflowUploads).not.toHaveBeenCalled();
  });

  it('aborts claimed uploads when conflict reload rejects before commit', async () => {
    const canvas = ownedCanvas();
    let selectCount = 0;
    const supabase = {
      from(table: string) {
        if (table !== 'workflow_canvases') throw new Error(`Unexpected table: ${table}`);
        return {
          select() {
            const query = {
              eq() { return query; },
              async single() {
                selectCount += 1;
                if (selectCount > 1) throw new Error('reload transport unavailable');
                return { data: canvas, error: null };
              },
            };
            return query;
          },
          update() {
            const query = {
              eq() { return query; },
              select() { return query; },
              async maybeSingle() { return { data: null, error: null }; },
            };
            return query;
          },
        };
      },
    } as unknown as SupabaseClient;
    const uploadClient = { kind: 'service-role' } as unknown as SupabaseClient;

    await expect(patchWorkflowCanvasForRoute({
      body: {
        title: 'Updated workflow',
        graph: createStarterGraph(),
        baseRevision: 4,
      },
      canvasId: canvas.id,
      supabase,
      uploadClient,
      userId: canvas.user_id,
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to update workflow canvas.' },
    });

    expect(uploadConsumptionMocks.abortPreparedWorkflowUploads)
      .toHaveBeenCalledWith(uploadClient, preparedLocations);
    expect(uploadConsumptionMocks.consumePersistedWorkflowUploads).not.toHaveBeenCalled();
  });
});
