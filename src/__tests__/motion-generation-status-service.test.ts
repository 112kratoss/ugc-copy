import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getMotionGenerationStatusForRoute,
  type MotionGenerationStatusDependencies,
} from '@/lib/motion-generation-status-service';

function createStatusClientMock(overrides: Record<string, unknown> = {}) {
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];
  const generation = {
    id: 'gen-motion-1',
    prediction_id: 'task-motion-1',
    user_id: 'user-1',
    status: 'succeeded',
    output_url: 'generated_videos/user-1/generated_task-motion-1.mp4',
    created_at: '2026-04-15T10:00:00.000Z',
    completed_at: '2026-04-15T10:01:00.000Z',
    model: 'kling-3.0',
    category: 'video',
    creation_mode: 'motion',
    duration: 6,
    workflow_settings: {
      mode: '1080p',
      duration: 6,
    },
    ...overrides,
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

describe('getMotionGenerationStatusForRoute', () => {
  it('returns cached succeeded output without polling the provider', async () => {
    const userClient = createStatusClientMock();
    const adminClient = {} as SupabaseClient;
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(async (_client, value: string) => `signed:${value}`),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<MotionGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient);

    const result = await getMotionGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate?id=task-motion-1'),
      predictionId: 'task-motion-1',
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
        output: 'signed:generated_videos/user-1/generated_task-motion-1.mp4',
        timing: expect.objectContaining({
          appStatus: 'succeeded',
          completedAtMs: Date.parse('2026-04-15T10:01:00.000Z'),
        }),
      },
    });
    expect(userClient.selects).toEqual([
      'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration',
    ]);
    expect(userClient.eqs).toEqual([
      { column: 'prediction_id', value: 'task-motion-1' },
      { column: 'user_id', value: 'user-1' },
    ]);
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });

  it('rejects a plain video generation before reading output or polling the provider', async () => {
    const userClient = createStatusClientMock({ creation_mode: null });
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<MotionGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => ({} as SupabaseClient));

    const result = await getMotionGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate?id=task-motion-1'),
      predictionId: 'task-motion-1',
      userId: 'user-1',
      supabase: userClient.client,
      createAdminSupabase,
      kieApiKey: 'test-key',
      dependencies,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Generation not found' },
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(dependencies.resolveStoredMediaUrl).not.toHaveBeenCalled();
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });
});
