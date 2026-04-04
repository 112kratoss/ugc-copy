import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GenerationRow = {
  id: string;
  user_id: string;
  prediction_id: string | null;
  status: string;
  output_url: string | null;
  model: string;
  category: string | null;
  workflow_settings: Record<string, unknown> | null;
  prompt?: string;
  cost?: number;
  duration?: number;
};

function createSupabaseMock(initialRows: GenerationRow[] = []) {
  const generations = [...initialRows];
  const uploads: Array<{ bucket: string; filePath: string }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const supabase = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });

      if (fn === 'deduct_credits') {
        return { data: 100, error: null };
      }

      if (fn === 'refund_generation' || fn === 'refund_credits') {
        return { data: true, error: null };
      }

      return { data: null, error: null };
    }),
    from: vi.fn((table: string) => {
      if (table !== 'generations') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return {
        insert(record: Record<string, unknown>) {
          const row: GenerationRow = {
            id: `gen-${generations.length + 1}`,
            user_id: String(record.user_id),
            prediction_id: typeof record.prediction_id === 'string' ? record.prediction_id : null,
            status: String(record.status),
            output_url: record.output_url ? String(record.output_url) : null,
            model: String(record.model),
            category: record.category ? String(record.category) : null,
            workflow_settings: (record.workflow_settings as Record<string, unknown>) ?? null,
            prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
            cost: typeof record.cost === 'number' ? record.cost : undefined,
            duration: typeof record.duration === 'number' ? record.duration : undefined,
          };
          generations.push(row);

          return {
            select() {
              return {
                async single() {
                  return { data: { id: row.id }, error: null };
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            async eq(column: string, value: unknown) {
              for (let index = 0; index < generations.length; index += 1) {
                if ((generations[index] as Record<string, unknown>)[column] === value) {
                  generations[index] = {
                    ...generations[index],
                    ...values,
                  } as GenerationRow;
                }
              }

              return { data: null, error: null };
            },
          };
        },
        select() {
          return {
            async in(column: string, values: unknown[]) {
              return {
                data: generations.filter((row) => values.includes((row as Record<string, unknown>)[column])),
                error: null,
              };
            },
            eq(column: string, value: unknown) {
              return {
                async single() {
                  const row = generations.find((candidate) => (candidate as Record<string, unknown>)[column] === value) || null;
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    }),
    storage: {
      from: vi.fn((bucket: string) => ({
        upload: vi.fn(async (filePath: string) => {
          uploads.push({ bucket, filePath });
          return { error: null };
        }),
      })),
    },
  };

  return {
    supabase: supabase as unknown as SupabaseClient,
    generations,
    uploads,
    rpcCalls,
  };
}

describe('generation services', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stores voiceover generations as audio records', async () => {
    const { startVoiceoverGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-voice-1' } }),
    } as Response);

    const { supabase, generations } = createSupabaseMock();
    const result = await startVoiceoverGeneration({
      supabase,
      userId: 'user-1',
      model: 'text-to-speech-turbo-2-5',
      text: 'Narrate this quickly.',
      voice: 'Rachel',
    });

    expect(result.predictionId).toBe('task-voice-1');
    expect(generations[0].category).toBe('audio');
    expect(generations[0].model).toBe('elevenlabs/text-to-speech-turbo-2-5');
    expect(generations[0].workflow_settings?.model).toBe('text-to-speech-turbo-2-5');
  });

  it('stores sound-effect generations as audio records', async () => {
    const { startSoundEffectGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-sfx-1' } }),
    } as Response);

    const { supabase, generations } = createSupabaseMock();
    const result = await startSoundEffectGeneration({
      supabase,
      userId: 'user-1',
      prompt: 'A soft whoosh and sparkle.',
      duration: 6,
    });

    expect(result.predictionId).toBe('task-sfx-1');
    expect(generations[0].category).toBe('audio');
    expect(generations[0].model).toBe('elevenlabs/sound-effect-v2');
    expect(generations[0].duration).toBe(6);
  });

  it('sends Kling video generations with variable single-shot duration', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-video-1' } }),
      } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    const result = await startVideoGeneration({
      supabase,
      userId: 'user-1',
      prompt: 'A product spins on a marble pedestal.',
      model: 'kling-3.0-video',
      duration: 7,
      mode: 'std',
      aspectRatio: '16:9',
      sound: true,
    });

    expect(result.predictionId).toBe('task-video-1');
    expect(providerBody).toMatchObject({
      model: 'kling-3.0/video',
      input: {
        prompt: 'A product spins on a marble pedestal.',
        multi_shots: false,
        duration: '7',
        aspect_ratio: '16:9',
        mode: 'std',
        sound: true,
      },
    });
    expect(generations[0].duration).toBe(7);
  });

  it('sends image generations with named elements first and stores compiled prompt metadata', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-image-advanced-1' } }),
      } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      userId: 'user-1',
      prompt: 'Use @hero on a clean tabletop scene.',
      model: 'nano-banana-2',
      imageUrls: [
        'https://cdn.example.com/hero.jpg',
        'https://cdn.example.com/reference.jpg',
      ],
      elements: [
        {
          id: 'element-1',
          displayName: 'Hero bottle',
          handle: '@hero',
          storagePath: null,
          sourceGenerationId: null,
        },
      ],
    });

    expect(providerBody).toMatchObject({
      model: 'nano-banana-2',
      input: {
        image_input: [
          'https://cdn.example.com/hero.jpg',
          'https://cdn.example.com/reference.jpg',
        ],
      },
    });
    expect(generations[0].workflow_settings?.elements).toEqual([
      expect.objectContaining({
        handle: '@hero',
        displayName: 'Hero bottle',
      }),
    ]);
    expect(String(generations[0].workflow_settings?.compiledPrompt)).toContain('@hero');
  });

  it('sends Veo video generations with start and end frames', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-veo-frames-1' } }),
      } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      userId: 'user-1',
      prompt: 'Move smoothly between the supplied frames.',
      model: 'veo-3.1',
      mode: 'veo3_fast',
      aspectRatio: '16:9',
      startImageUrl: 'https://cdn.example.com/start.jpg',
      endImageUrl: 'https://cdn.example.com/end.jpg',
    });

    expect(providerBody).toMatchObject({
      model: 'veo3_fast',
      generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO',
      imageUrls: [
        'https://cdn.example.com/start.jpg',
        'https://cdn.example.com/end.jpg',
      ],
    });
    expect(generations[0].workflow_settings?.referenceMode).toBe('frames');
  });

  it('sends Seedance 2 generations with image, video, and audio references', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-seedance-advanced-1' } }),
      } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      userId: 'user-1',
      prompt: 'Match the motion and timing references.',
      model: 'seedance-2-fast',
      duration: 12,
      aspectRatio: '16:9',
      resolution: '480p',
      sound: true,
      references: [
        {
          url: 'asset-image-1',
          handle: '@hero',
          displayName: 'Hero',
          storagePath: 'uploads/user-1/hero.png',
          sourceGenerationId: null,
        },
      ],
      referenceVideoUrls: ['asset-video-1'],
      referenceAudioUrls: ['asset-audio-1'],
      seedanceAssets: {
        images: [{ assetId: 'asset-image-1', assetType: 'Image', status: 'active', sourceUrl: 'https://signed.example.com/hero.png', error: null, lastCheckedAt: '2026-04-04T00:00:00.000Z' }],
        videos: [{ assetId: 'asset-video-1', assetType: 'Video', status: 'active', sourceUrl: 'https://signed.example.com/ref.mp4', error: null, lastCheckedAt: '2026-04-04T00:00:00.000Z' }],
        audios: [{ assetId: 'asset-audio-1', assetType: 'Audio', status: 'active', sourceUrl: 'https://signed.example.com/ref.wav', error: null, lastCheckedAt: '2026-04-04T00:00:00.000Z' }],
      },
    });

    expect(providerBody).toMatchObject({
      model: 'bytedance/seedance-2-fast',
      input: {
        prompt: 'Match the motion and timing references.',
        reference_image_urls: ['asset-image-1'],
        reference_video_urls: ['asset-video-1'],
        reference_audio_urls: ['asset-audio-1'],
        generate_audio: true,
        resolution: '480p',
        aspect_ratio: '16:9',
        duration: 12,
        web_search: false,
        return_last_frame: false,
      },
    });
    expect(generations[0].cost).toBe(96);
    expect(generations[0].workflow_settings).toMatchObject({
      referenceVideoUrls: ['asset-video-1'],
      referenceAudioUrls: ['asset-audio-1'],
      seedanceAssets: {
        images: [expect.objectContaining({ assetId: 'asset-image-1' })],
      },
    });
  });

  it('syncs processing audio generations into succeeded storage-backed outputs', async () => {
    const { syncGenerationStatuses } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            state: 'success',
            resultJson: JSON.stringify({ resultUrls: ['https://cdn.example.com/audio.mp3'] }),
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['audio'], { type: 'audio/mpeg' }),
      } as Response);

    const { supabase, generations, uploads } = createSupabaseMock([{
      id: 'gen-audio-1',
      user_id: 'user-1',
      prediction_id: 'task-audio-1',
      status: 'processing',
      output_url: null,
      model: 'elevenlabs/text-to-speech-turbo-2-5',
      category: 'audio',
      workflow_settings: { model: 'text-to-speech-turbo-2-5' },
    }]);

    await syncGenerationStatuses({
      supabase,
      generationIds: ['gen-audio-1'],
    });

    expect(generations[0].status).toBe('succeeded');
    expect(generations[0].output_url).toBe('generated_audio/user-1/generated_task-audio-1.mp3');
    expect(uploads[0]).toEqual({
      bucket: 'generated_audio',
      filePath: 'user-1/generated_task-audio-1.mp3',
    });
  });

  it('refunds failed async generations once', async () => {
    const { syncGenerationStatuses } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          state: 'fail',
          failMsg: 'provider failure',
        },
      }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock([{
      id: 'gen-audio-2',
      user_id: 'user-1',
      prediction_id: 'task-audio-2',
      status: 'processing',
      output_url: null,
      model: 'elevenlabs/sound-effect-v2',
      category: 'audio',
      workflow_settings: { model: 'sound-effect-v2' },
    }]);

    await syncGenerationStatuses({
      supabase,
      generationIds: ['gen-audio-2'],
    });

    expect(generations[0].status).toBe('failed');
    expect(rpcCalls.some((call) => call.fn === 'refund_generation' && call.args.p_prediction_id === 'task-audio-2')).toBe(true);
  });
});
