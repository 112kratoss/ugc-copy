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
  client_request_key_hash?: string | null;
  created_at?: string;
  completed_at?: string | null;
};

function createSupabaseMock(initialRows: GenerationRow[] = []) {
  const generations = [...initialRows];
  const uploads: Array<{ bucket: string; filePath: string }> = [];
  const inputMediaRows: Record<string, unknown>[] = [];
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
      if (table === 'generation_input_media') {
        return {
          async insert(record: Record<string, unknown>) {
            inputMediaRows.push(record);
            return { data: null, error: null };
          },
        };
      }

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
            client_request_key_hash: typeof record.client_request_key_hash === 'string'
              ? record.client_request_key_hash
              : null,
            created_at: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
            completed_at: typeof record.completed_at === 'string' ? record.completed_at : null,
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
        download: vi.fn(async (filePath: string) => {
          if (bucket === 'uploads') {
            return {
              data: new Blob([`stored:${filePath}`], { type: filePath.endsWith('.mp4') ? 'video/mp4' : 'image/png' }),
              error: null,
            };
          }

          return { data: null, error: { message: 'missing' } };
        }),
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
    inputMediaRows,
    rpcCalls,
  };
}

describe('generation services', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.KIE_AI_API_KEY = 'test-key';
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
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
      creditSupabase: supabase,
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

  it('attaches the durable completion webhook to every provider task', async () => {
    const { startVoiceoverGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-callback-1' } }),
      } as Response;
    });

    const { supabase } = createSupabaseMock();
    await startVoiceoverGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      model: 'text-to-speech-turbo-2-5',
      text: 'Notify the backend when this is ready.',
      voice: 'Rachel',
    });

    expect(providerBody).toMatchObject({
      callBackUrl: 'https://magicbooklet.com/api/webhooks/kie?secret=test-webhook-secret',
    });
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
      creditSupabase: supabase,
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
      creditSupabase: supabase,
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
      creditSupabase: supabase,
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

  it('snapshots uploaded image inputs after creating the generation record', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-snapshot-1' } }),
    } as Response);

    const { supabase, uploads, inputMediaRows } = createSupabaseMock();
    const result = await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Use @hero in a clean scene.',
      model: 'nano-banana-2',
      imageUrls: ['https://signed.example.com/hero.png'],
      elements: [
        {
          id: 'element-1',
          displayName: 'Hero product',
          handle: '@hero',
          storagePath: 'uploads/user-1/hero.png',
          sourceGenerationId: null,
        },
      ],
    });

    expect(result.generationId).toBe('gen-1');
    expect(uploads).toContainEqual({
      bucket: 'generation_inputs',
      filePath: 'user-1/gen-1/00-reference_image.png',
    });
    expect(inputMediaRows[0]).toMatchObject({
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'image',
      role: 'reference_image',
      label: 'Hero product',
      storage_path: 'generation_inputs/user-1/gen-1/00-reference_image.png',
      metadata: expect.objectContaining({
        handle: '@hero',
      }),
    });
  });

  it('uses GPT Image 2 text-to-image provider payload when no references are attached', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-gpt-image-2-text-1' } }),
      } as Response;
    });

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A premium skincare product hero image.',
      model: 'gpt-image-2',
      aspectRatio: '4:5',
      resolution: '2K',
    });

    expect(providerBody).toEqual({
      callBackUrl: 'https://magicbooklet.com/api/webhooks/kie?secret=test-webhook-secret',
      model: 'gpt-image-2-text-to-image',
      input: {
        prompt: 'A premium skincare product hero image.',
        aspect_ratio: '4:5',
        resolution: '2K',
      },
    });
    expect(rpcCalls[0]).toMatchObject({
      fn: 'deduct_credits',
      args: { p_cost: 10 },
    });
    expect(generations[0]).toMatchObject({
      model: 'gpt-image-2',
      cost: 10,
    });
    expect(generations[0].workflow_settings).toMatchObject({
      model: 'gpt-image-2',
      providerModel: 'gpt-image-2-text-to-image',
    });
  });

  it('stores generation start idempotency hashes on created image rows', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-idempotent-1' } }),
    } as Response);

    const { supabase, generations } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'a'.repeat(64),
      prompt: 'A premium skincare product hero image.',
      model: 'nano-banana-2',
    });

    expect(generations[0].client_request_key_hash).toBe('a'.repeat(64));
  });

  it('reserves a pending image generation before submitting provider work', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    const { supabase, generations } = createSupabaseMock();
    fetchMock.mockImplementation(async () => {
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        status: 'pending',
        prediction_id: null,
        client_request_key_hash: 'b'.repeat(64),
      });
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-image-durable-1' } }),
      } as Response;
    });

    const result = await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'b'.repeat(64),
      prompt: 'A premium skincare product hero image.',
      model: 'nano-banana-2',
    });

    expect(result.generationId).toBe('gen-1');
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-image-durable-1',
      client_request_key_hash: 'b'.repeat(64),
    });
  });

  it('marks a reserved image generation failed and retryable when provider submission fails', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 500, msg: 'Provider unavailable' }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'c'.repeat(64),
      prompt: 'A premium skincare product hero image.',
      model: 'nano-banana-2',
    })).rejects.toThrow('Provider unavailable');

    expect(rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ fn: 'deduct_credits' }),
      expect.objectContaining({ fn: 'refund_credits' }),
    ]));
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      status: 'failed',
      prediction_id: null,
      client_request_key_hash: null,
    });
    expect(generations[0].completed_at).toEqual(expect.any(String));
  });

  it('uses GPT Image 2 image-to-image provider payload when references are attached', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-gpt-image-2-edit-1' } }),
      } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Keep @hero but change the background to warm marble.',
      model: 'gpt-image-2',
      imageUrls: ['https://cdn.example.com/hero.png'],
      elements: [
        {
          id: 'element-1',
          displayName: 'Hero product',
          handle: '@hero',
          storagePath: null,
          sourceGenerationId: null,
        },
      ],
      aspectRatio: '1:1',
      resolution: '2K',
    });

    expect(providerBody).toMatchObject({
      model: 'gpt-image-2-image-to-image',
      input: {
        input_urls: ['https://cdn.example.com/hero.png'],
        aspect_ratio: '1:1',
        resolution: '2K',
      },
    });
    const providerInput = (providerBody as unknown as { input: Record<string, unknown> }).input;
    expect(providerInput).not.toHaveProperty('image_input');
    expect(providerInput).not.toHaveProperty('output_format');
    expect(generations[0].workflow_settings).toMatchObject({
      providerModel: 'gpt-image-2-image-to-image',
      elements: [
        expect.objectContaining({
          handle: '@hero',
        }),
      ],
    });
  });

  it('rejects invalid GPT Image 2 resolution combinations before deducting credits', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const { supabase, rpcCalls } = createSupabaseMock();

    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A square product visual.',
      model: 'gpt-image-2',
      aspectRatio: '1:1',
      resolution: '4K',
    })).rejects.toThrow('GPT Image 2 supports 1K, 2K at aspect ratio 1:1.');

    expect(rpcCalls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses Grok text-to-image provider payload and quality pricing without references', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-grok-image-text-1' } }),
      } as Response;
    });

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A surreal product launch poster.',
      model: 'grok-imagine-image',
      aspectRatio: '3:2',
      qualityMode: 'quality',
    });

    expect(providerBody).toEqual({
      callBackUrl: 'https://magicbooklet.com/api/webhooks/kie?secret=test-webhook-secret',
      model: 'grok-imagine/text-to-image',
      input: {
        prompt: 'A surreal product launch poster.',
        nsfw_checker: true,
        aspect_ratio: '3:2',
        enable_pro: true,
      },
    });
    expect(rpcCalls[0]).toMatchObject({
      fn: 'deduct_credits',
      args: { p_cost: 5 },
    });
    expect(generations[0]).toMatchObject({
      model: 'grok-imagine-image',
      cost: 5,
    });
    expect(generations[0].workflow_settings).toMatchObject({
      providerModel: 'grok-imagine/text-to-image',
      qualityMode: 'quality',
    });
  });

  it('uses Grok image-to-image provider payload and fixed edit pricing with one reference', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-grok-image-edit-1' } }),
      } as Response;
    });

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Restyle @hero as a neon storefront campaign.',
      model: 'grok-imagine-image',
      imageUrls: ['https://cdn.example.com/hero.png'],
      qualityMode: 'quality',
      elements: [
        {
          id: 'element-1',
          displayName: 'Hero',
          handle: '@hero',
          storagePath: null,
          sourceGenerationId: null,
        },
      ],
    });

    expect(providerBody).toMatchObject({
      model: 'grok-imagine/image-to-image',
      input: {
        image_urls: ['https://cdn.example.com/hero.png'],
        nsfw_checker: true,
      },
    });
    expect((providerBody as unknown as { input: Record<string, unknown> }).input).not.toHaveProperty('enable_pro');
    expect(rpcCalls[0]).toMatchObject({
      fn: 'deduct_credits',
      args: { p_cost: 4 },
    });
    expect(generations[0].workflow_settings).toMatchObject({
      providerModel: 'grok-imagine/image-to-image',
    });
  });

  it('rejects Grok image runs with more than one reference before deducting credits', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const { supabase, rpcCalls } = createSupabaseMock();

    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Combine these references.',
      model: 'grok-imagine-image',
      imageUrls: ['https://cdn.example.com/one.png', 'https://cdn.example.com/two.png'],
    })).rejects.toThrow('Grok Imagine supports up to 1 total reference images.');

    expect(rpcCalls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
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
      creditSupabase: supabase,
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

  it('reserves a pending video generation before submitting provider work', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    const { supabase, generations } = createSupabaseMock();
    fetchMock.mockImplementation(async () => {
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        status: 'pending',
        prediction_id: null,
        client_request_key_hash: 'd'.repeat(64),
        category: 'video',
      });
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-video-durable-1' } }),
      } as Response;
    });

    const result = await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'd'.repeat(64),
      prompt: 'A product spins on a marble pedestal.',
      model: 'kling-3.0-video',
      duration: 7,
      mode: 'std',
      aspectRatio: '16:9',
      sound: true,
    });

    expect(result.generationId).toBe('gen-1');
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-video-durable-1',
      client_request_key_hash: 'd'.repeat(64),
    });
  });

  it('uses Grok text-to-video provider payload without references', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-grok-video-text-1' } }),
      } as Response;
    });

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A playful product reveal with quick camera energy.',
      model: 'grok-imagine-video',
      mode: 'fun',
      aspectRatio: '16:9',
      duration: 6,
      resolution: '480p',
    });

    expect(providerBody).toEqual({
      callBackUrl: 'https://magicbooklet.com/api/webhooks/kie?secret=test-webhook-secret',
      model: 'grok-imagine/text-to-video',
      input: {
        prompt: 'A playful product reveal with quick camera energy.',
        mode: 'fun',
        duration: 6,
        resolution: '480p',
        nsfw_checker: true,
        aspect_ratio: '16:9',
      },
    });
    expect(rpcCalls[0]).toMatchObject({
      fn: 'deduct_credits',
      args: { p_cost: 10 },
    });
    expect(generations[0]).toMatchObject({
      model: 'grok-imagine/text-to-video',
      cost: 10,
      duration: 6,
    });
    expect(generations[0].workflow_settings).toMatchObject({
      model: 'grok-imagine-video',
      providerModel: 'grok-imagine/text-to-video',
      providerMode: 'fun',
    });
  });

  it('uses Grok image-to-video payload and coerces spicy external images to normal', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-grok-video-image-1' } }),
      } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Animate the still with a slow push-in.',
      model: 'grok-imagine-video',
      mode: 'spicy',
      aspectRatio: '9:16',
      duration: 10,
      resolution: '720p',
      startImageUrl: 'https://cdn.example.com/start.jpg',
    });

    expect(providerBody).toEqual({
      callBackUrl: 'https://magicbooklet.com/api/webhooks/kie?secret=test-webhook-secret',
      model: 'grok-imagine/image-to-video',
      input: {
        prompt: 'Animate the still with a slow push-in.',
        mode: 'normal',
        duration: 10,
        resolution: '720p',
        nsfw_checker: true,
        image_urls: ['https://cdn.example.com/start.jpg'],
      },
    });
    expect(generations[0].workflow_settings).toMatchObject({
      providerModel: 'grok-imagine/image-to-video',
      requestedMode: 'spicy',
      providerMode: 'normal',
    });
  });

  it('rejects Grok image-to-video runs with more than one frame before deducting credits', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const { supabase, rpcCalls } = createSupabaseMock();

    await expect(startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Move between these images.',
      model: 'grok-imagine-video',
      mode: 'normal',
      duration: 6,
      resolution: '480p',
      startImageUrl: 'https://cdn.example.com/start.jpg',
      endImageUrl: 'https://cdn.example.com/end.jpg',
    })).rejects.toThrow('Grok Imagine Video supports up to 1 image reference per run.');

    expect(rpcCalls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects motion generation before charging when webhook secret is missing', async () => {
    delete process.env.WEBHOOK_SECRET;
    const { startMotionGeneration } = await import('@/lib/generation-services');
    const { supabase, rpcCalls } = createSupabaseMock();

    await expect(startMotionGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Match the reference motion.',
      model: 'kling-3.0',
      referenceVideoUrl: 'https://cdn.example.com/reference.mp4',
      characterImageUrl: 'https://cdn.example.com/character.png',
      duration: 6,
      characterOrientation: 'image',
      mode: '1080p',
    })).rejects.toThrow('Server configuration error: webhook secret missing');

    expect(rpcCalls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reserves a pending motion generation before submitting provider work', async () => {
    const { startMotionGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    const { supabase, generations } = createSupabaseMock();
    fetchMock.mockImplementation(async () => {
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        status: 'pending',
        prediction_id: null,
        client_request_key_hash: 'e'.repeat(64),
        category: 'video',
      });
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-motion-durable-1' } }),
      } as Response;
    });

    const result = await startMotionGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'e'.repeat(64),
      prompt: 'Match the reference motion.',
      model: 'kling-3.0',
      referenceVideoUrl: 'https://cdn.example.com/reference.mp4',
      characterImageUrl: 'https://cdn.example.com/character.png',
      duration: 6,
      characterOrientation: 'image',
      mode: '1080p',
    });

    expect(result.generationId).toBe('gen-1');
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-motion-durable-1',
      client_request_key_hash: 'e'.repeat(64),
    });
  });

  it('sends Kling single-shot generations with named video elements', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-kling-video-element-1' } }),
      } as Response;
    });

    const { supabase, generations, inputMediaRows } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Replace the background motion with @reference_dancer.',
      model: 'kling-3.0-video',
      duration: 5,
      aspectRatio: '16:9',
      mode: 'std',
      klingVideoElements: [
        {
          url: 'https://cdn.example.com/ref-dancer.mp4',
          handle: '@reference_dancer',
          displayName: 'Reference dancer',
          storagePath: 'uploads/user-1/ref-dancer.mp4',
          sourceGenerationId: 'source-video-1',
        },
      ],
    });

    expect(providerBody).toMatchObject({
      model: 'kling-3.0/video',
      input: {
        prompt: 'Replace the background motion with @reference_dancer.',
        kling_elements: [
          {
            name: 'reference_dancer',
            description: 'Reference dancer',
            element_input_video_urls: ['https://cdn.example.com/ref-dancer.mp4'],
          },
        ],
      },
    });
    expect(generations[0].workflow_settings).toMatchObject({
      klingVideoElements: [
        expect.objectContaining({
          handle: '@reference_dancer',
          displayName: 'Reference dancer',
          storagePath: 'uploads/user-1/ref-dancer.mp4',
          sourceGenerationId: 'source-video-1',
        }),
      ],
    });
    expect(inputMediaRows[0]).toMatchObject({
      media_type: 'video',
      role: 'reference_video',
      label: 'Reference dancer',
      source_generation_id: 'source-video-1',
      metadata: expect.objectContaining({
        handle: '@reference_dancer',
        displayName: 'Reference dancer',
      }),
    });
  });

  it('sends Kling multi-shot generations with named video elements', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-kling-video-element-2' } }),
      } as Response;
    });

    const { supabase } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: '',
      model: 'kling-3.0-video',
      isMultiShot: true,
      mode: 'pro',
      aspectRatio: '9:16',
      multiPrompts: [
        { id: 'shot-1', prompt: 'Track the runway walk from @motion_ref.', duration: 3 },
        { id: 'shot-2', prompt: 'Cut closer while @motion_ref turns.', duration: 4 },
      ],
      klingVideoElements: [
        {
          url: 'asset-video-1',
          handle: '@motion_ref',
          displayName: 'Motion ref',
          storagePath: null,
          sourceGenerationId: null,
        },
      ],
    });

    expect(providerBody).toMatchObject({
      model: 'kling-3.0/video',
      input: {
        multi_shots: true,
        multi_prompt: [
          { prompt: 'Track the runway walk from @motion_ref.', duration: 3 },
          { prompt: 'Cut closer while @motion_ref turns.', duration: 4 },
        ],
        kling_elements: [
          {
            name: 'motion_ref',
            description: 'Motion ref',
            element_input_video_urls: ['asset-video-1'],
          },
        ],
      },
    });
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
      creditSupabase: supabase,
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
          createTime: '2026-04-15T10:00:00.000Z',
          completeTime: '2026-04-15T10:00:12.000Z',
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
      created_at: '2026-04-15T10:00:00.000Z',
    }]);

    await syncGenerationStatuses({
      supabase,
      creditSupabase: supabase,
      generationIds: ['gen-audio-1'],
    });

    expect(generations[0].status).toBe('succeeded');
    expect(generations[0].output_url).toBe('generated_audio/user-1/generated_task-audio-1.mp3');
    expect(generations[0].completed_at).toBe('2026-04-15T10:00:12.000Z');
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
          completeTime: '2026-04-15T10:01:00.000Z',
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
      created_at: '2026-04-15T10:00:00.000Z',
    }]);

    await syncGenerationStatuses({
      supabase,
      creditSupabase: supabase,
      generationIds: ['gen-audio-2'],
    });

    expect(generations[0].status).toBe('failed');
    expect(generations[0].completed_at).toBe('2026-04-15T10:01:00.000Z');
    expect(rpcCalls.some((call) => call.fn === 'refund_generation' && call.args.p_prediction_id === 'task-audio-2')).toBe(true);
  });

  it('syncs one generation by provider task id for webhook completion jobs', async () => {
    const { syncGenerationStatusByPredictionId } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          state: 'fail',
          completeTime: '2026-04-15T10:02:00.000Z',
          failMsg: 'provider failure',
        },
      }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock([{
      id: 'gen-audio-3',
      user_id: 'user-1',
      prediction_id: 'task-audio-3',
      status: 'processing',
      output_url: null,
      model: 'elevenlabs/sound-effect-v2',
      category: 'audio',
      workflow_settings: { model: 'sound-effect-v2' },
      created_at: '2026-04-15T10:00:00.000Z',
    }]);

    await expect(syncGenerationStatusByPredictionId({
      supabase,
      creditSupabase: supabase,
      predictionId: 'task-audio-3',
    })).resolves.toMatchObject({
      found: true,
      status: 'failed',
      generation: {
        id: 'gen-audio-3',
        prediction_id: 'task-audio-3',
        status: 'failed',
      },
    });

    expect(generations[0].status).toBe('failed');
    expect(generations[0].completed_at).toBe('2026-04-15T10:02:00.000Z');
    expect(rpcCalls.some((call) => call.fn === 'refund_generation' && call.args.p_prediction_id === 'task-audio-3')).toBe(true);
  });

  it('applies terminal webhook failure payloads without polling provider status', async () => {
    const { syncGenerationStatusByPredictionId } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new Error('provider status should not be polled'));

    const { supabase, generations, rpcCalls } = createSupabaseMock([{
      id: 'gen-webhook-fail-1',
      user_id: 'user-1',
      prediction_id: 'task-webhook-fail-1',
      status: 'processing',
      output_url: null,
      model: 'elevenlabs/sound-effect-v2',
      category: 'audio',
      workflow_settings: { model: 'sound-effect-v2' },
      created_at: '2026-04-15T10:00:00.000Z',
    }]);

    await expect(syncGenerationStatusByPredictionId({
      supabase,
      creditSupabase: supabase,
      predictionId: 'task-webhook-fail-1',
      providerPayload: {
        data: {
          taskId: 'task-webhook-fail-1',
          state: 'fail',
          completeTime: '2026-04-15T10:03:00.000Z',
          failMsg: 'provider rejected the request',
        },
      },
    })).resolves.toMatchObject({
      found: true,
      status: 'failed',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(generations[0].status).toBe('failed');
    expect(generations[0].completed_at).toBe('2026-04-15T10:03:00.000Z');
    expect(rpcCalls.some((call) => call.fn === 'refund_generation' && call.args.p_prediction_id === 'task-webhook-fail-1')).toBe(true);
  });
});
