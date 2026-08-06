import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getVideoGenerationStatusForRoute,
  type VideoGenerationStatusDependencies,
} from '@/lib/video-generation-status-service';

function createStatusClientMock(overrides: Record<string, unknown> = {}) {
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
    creation_mode: null,
    workflow_settings: null,
    duration: 5,
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

describe('getVideoGenerationStatusForRoute', () => {
  it('returns cached succeeded output from storage without polling the provider', async () => {
    const userClient = createStatusClientMock();
    const adminClient = createStatusClientMock();
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(async () => 'signed:video-url'),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<VideoGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient.client);

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
    // The lookup must run service-role: `authenticated` cannot SELECT output_url,
    // model, completed_at or workflow_settings, so reading it as the user denies
    // the row and the caller reports a phantom "Generation not found".
    expect(adminClient.selects).toEqual([
      'id, user_id, prediction_id, status, output_url, created_at, completed_at, model, category, creation_mode, workflow_settings, duration',
    ]);
    expect(adminClient.eqs).toEqual([
      { column: 'prediction_id', value: 'task-video-1' },
      { column: 'user_id', value: 'user-1' },
    ]);
    expect(userClient.selects).toEqual([]);
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).toHaveBeenCalledWith(
      adminClient.client,
      'generated_videos/user-1/generated_task-video-1.mp4',
    );
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });

  it('rejects a motion generation before reading output or polling the provider', async () => {
    const userClient = createStatusClientMock({ creation_mode: 'motion' });
    const adminClient = createStatusClientMock({ creation_mode: 'motion' });
    const dependencies = {
      resolveStoredMediaUrl: vi.fn(),
      fetchWithProviderTimeout: vi.fn(),
    } satisfies Partial<VideoGenerationStatusDependencies>;
    const createAdminSupabase = vi.fn(() => adminClient.client);

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
      ok: false,
      status: 404,
      body: { error: 'Generation not found' },
    });
    // Only the ownership/kind lookup runs; the rejection still happens before any
    // media resolution or provider poll, which is what this test guards.
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(dependencies.resolveStoredMediaUrl).not.toHaveBeenCalled();
    expect(dependencies.fetchWithProviderTimeout).not.toHaveBeenCalled();
  });
});
