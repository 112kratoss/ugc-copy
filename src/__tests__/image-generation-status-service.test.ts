import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getImageGenerationStatusForRoute,
  type ImageGenerationStatusDependencies,
} from '@/lib/image-generation-status-service';

function createStatusClientMock() {
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];
  const generation = {
    id: 'gen-image-1',
    prediction_id: 'task-image-1',
    user_id: 'user-1',
    status: 'succeeded',
    output_url: 'generated_images/user-1/generated_task-image-1.png',
    created_at: '2026-04-15T10:00:00.000Z',
    completed_at: '2026-04-15T10:01:00.000Z',
    model: 'grok-imagine-image',
    category: 'image',
    workflow_settings: {
      outputs: [
        { storagePath: 'generated_images/user-1/output-1.png' },
        { storagePath: 'generated_images/user-1/output-2.png' },
      ],
    },
  };

  const client = {
    from(table: string) {
      if (table !== 'generations') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        select(columns = '') {
          selects.push(columns);
          const filters: Record<string, unknown> = {};
          const query = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              eqs.push({ column, value });
              return query;
            },
            single() {
              if (
                filters.prediction_id === generation.prediction_id
                && filters.user_id === generation.user_id
              ) {
                return Promise.resolve({ data: generation, error: null });
              }

              return Promise.resolve({ data: null, error: null });
            },
          };

          return query;
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    selects,
    eqs,
  };
}

describe('getImageGenerationStatusForRoute', () => {
  it('returns cached succeeded output and persisted output list without polling the provider', async () => {
    const userClient = createStatusClientMock();
    const adminClient = {} as SupabaseClient;
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(async (_client, value: string) => `signed:${value}`),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<ImageGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient);

    const result = await getImageGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate-image?id=task-image-1'),
      predictionId: 'task-image-1',
      userId: 'user-1',
      supabase: userClient.client,
      createAdminSupabase,
      kieApiKey: 'test-key',
      dependencies,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        status: 'succeeded',
        output: 'signed:generated_images/user-1/generated_task-image-1.png',
        outputs: [
          'signed:generated_images/user-1/output-1.png',
          'signed:generated_images/user-1/output-2.png',
        ],
        timing: expect.objectContaining({
          appStatus: 'succeeded',
          completedAtMs: Date.parse('2026-04-15T10:01:00.000Z'),
        }),
      },
    });
    expect(userClient.selects).toEqual([
      'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings',
    ]);
    expect(userClient.eqs).toEqual([
      { column: 'prediction_id', value: 'task-image-1' },
      { column: 'user_id', value: 'user-1' },
    ]);
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenCalledTimes(3);
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });
});
