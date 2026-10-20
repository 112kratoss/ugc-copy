import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_INPUT_REFUSED } from '@/lib/generation-public-failure';

// The provider key and the callback settings are read when the generation
// modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
  vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
  vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
});

/** A database each refusal here must come before: the start's hold is its first call. */
function untouchedDatabase() {
  const calls: string[] = [];
  const supabase = {
    rpc: vi.fn(async (fn: string) => {
      calls.push(`rpc:${fn}`);
      return { data: null, error: { message: 'not expected' } };
    }),
    from: vi.fn((table: string) => {
      calls.push(`from:${table}`);
      throw new Error(`not expected: ${table}`);
    }),
    storage: {
      from: vi.fn((bucket: string) => {
        calls.push(`storage:${bucket}`);
        throw new Error(`not expected: ${bucket}`);
      }),
    },
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

/**
 * What a start refuses for what Kie would refuse after the hold (provider-input-limits)
 * carries its own code, so a canvas or template step can tell it from a provider's
 * rejection and say it in its own words. POST /api/generations already did.
 */
describe('a start refused for what its provider would refuse', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function expectRefusal(start: (supabase: SupabaseClient) => Promise<unknown>, message: string) {
    const { GenerationServiceError } = await import('@/lib/generation-services');
    const { supabase, calls } = untouchedDatabase();

    const refusal = await start(supabase).then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(GenerationServiceError);
    expect(refusal).toMatchObject({ status: 400, failureCode: PROVIDER_INPUT_REFUSED, message });
    expect(calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    return refusal;
  }

  it('codes a prompt over its model’s own cap', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    await expectRefusal((supabase) => startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'a'.repeat(1001),
      model: 'z-image',
      privateRecipe: true,
      persistInputMedia: false,
      templateContext: { runId: 'run-1', stepId: 'step-1' },
    }), 'Z-Image prompts support up to 1,000 characters.');
  });

  it('codes a reference clip shorter than its model takes', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    await expectRefusal((supabase) => startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Follow the dance in the clip.',
      model: 'seedance-2',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
      referenceMode: 'elements',
      referenceVideoUrls: ['https://cdn.example.com/dance.mp4'],
      referenceVideos: [{ kind: 'video', label: 'Dance clip', storagePath: null, sourceGenerationId: null, durationSeconds: 1.5 }],
    }), 'Seedance 2 reference videos must be at least 2 seconds long. Dance clip runs 1.5 seconds.');
  });

  it('codes a motion performance under its model’s 3 s', async () => {
    const { startMotionGeneration } = await import('@/lib/generation-services');
    await expectRefusal((supabase) => startMotionGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: '',
      model: 'kling-2.6',
      referenceVideoUrl: 'https://cdn.example.com/reference.mp4',
      characterImageUrl: 'https://cdn.example.com/character.png',
      duration: 3,
      referenceVideoSeconds: 2.47,
    }), 'Kling 2.6 motion reference videos must be at least 3 seconds long. The reference video runs 2.4 seconds.');
  });

  it('codes a catalog run’s prompt and its reference track alike', async () => {
    const { startCatalogGeneration } = await import('@/lib/generation-services');
    const { buildCodeGenerationModelOperations } = await import('@/lib/generation-model-runtime');
    const operation = (modelId: string) => buildCodeGenerationModelOperations().find((entry) => entry.modelId === modelId)!;

    await expectRefusal((supabase) => startCatalogGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      operation: operation('z-image'),
      catalogRevision: 'rev-1',
      prompt: 'a'.repeat(1001),
      settings: { aspectRatio: '1:1' },
      quotedCostCredits: 1,
    }), 'Z-Image prompts support up to 1,000 characters.');

    await expectRefusal((supabase) => startCatalogGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      operation: operation('seedance-2-5'),
      catalogRevision: 'rev-1',
      prompt: 'Dance to the beat.',
      settings: { duration: 5 },
      inputs: [{ slot: 'audioReferences', kind: 'audio', url: 'https://cdn.example.com/beat.mp3', label: 'Beat', durationSeconds: 1.9 }],
      quotedCostCredits: 1,
    }), 'Seedance 2.5 reference audio must be at least 2 seconds long. Beat runs 1.9 seconds.');
  });

  it('is answered by the start routes as before: an invalid request, in its own words', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const { mapGenerationStartRouteError } = await import('@/lib/unified-generation-route-service');
    const refusal = await expectRefusal((supabase) => startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'a'.repeat(1001),
      model: 'z-image',
    }), 'Z-Image prompts support up to 1,000 characters.');

    expect(mapGenerationStartRouteError(refusal, { logEvent: 'test_start_failed', fallbackMessage: 'Failed.' })).toEqual({
      ok: false,
      status: 400,
      body: { code: 'INVALID_GENERATION_REQUEST', error: 'Z-Image prompts support up to 1,000 characters.' },
    });
  });
});
