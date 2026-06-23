import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getVideoGenerationStatusForRoute,
  type VideoGenerationStatusDependencies,
} from '@/lib/video-generation-status-service';

function createStatusClientMock() {
  const selects: string[] = [];
  const eqs: Array<{ column: string; value: unknown }> = [];
  const generation = {
    id: 'gen-video-1',
    prediction_id: 'task-video-1',
    user_id: 'user-1',
    status: 'succeeded',
    output_url: 'generated_videos/user-1/generated_task-video-1.mp4',
    created_at: '2026-04-15T10:00:00.000Z',
    completed_at: '2026-04-15T10:01:00.000Z',
    model: 'kling-3.0-video',
    category: 'video',
    workflow_settings: null,
    duration: 5,
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

describe('getVideoGenerationStatusForRoute', () => {
  it('returns cached succeeded output from storage without polling the provider', async () => {
    const userClient = createStatusClientMock();
    const adminClient = {} as SupabaseClient;
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(async () => 'signed:video-url'),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<VideoGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient);

    const result = await getVideoGenerationStatusForRoute({
      request: new Request('http://localhost/api/generate-video?id=task-video-1'),
      predictionId: 'task-video-1',
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
        output: 'signed:video-url',
        timing: expect.objectContaining({
          appStatus: 'succeeded',
          completedAtMs: Date.parse('2026-04-15T10:01:00.000Z'),
        }),
      },
    });
    expect(userClient.selects).toEqual([
      'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, workflow_settings, duration',
    ]);
    expect(userClient.eqs).toEqual([
      { column: 'prediction_id', value: 'task-video-1' },
      { column: 'user_id', value: 'user-1' },
    ]);
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenCalledWith(
      adminClient,
      'generated_videos/user-1/generated_task-video-1.mp4',
    );
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });
});
