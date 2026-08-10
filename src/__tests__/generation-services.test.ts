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
  refunded?: boolean;
  error_message?: string | null;
  template_run_id?: string | null;
  template_run_step_id?: string | null;
  submission_unknown_at?: string | null;
};

type SupabaseMockOptions = {
  generationInsertErrors?: Error[];
  generationUpdateErrors?: Error[];
  sharedGenerations?: GenerationRow[];
  /** Force a named RPC to fail, for testing fallback paths. */
  rpcErrors?: Record<string, { message: string }>;
  /** Force a named RPC to return a specific payload, for testing race outcomes. */
  rpcResults?: Record<string, unknown>;
};

function createSupabaseMock(initialRows: GenerationRow[] = [], options: SupabaseMockOptions = {}) {
  const generations = options.sharedGenerations ?? [...initialRows];
  const uploads: Array<{ bucket: string; filePath: string }> = [];
  const inputMediaRows: Record<string, unknown>[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const generationInsertErrors = [...(options.generationInsertErrors ?? [])];
  const generationUpdateErrors = [...(options.generationUpdateErrors ?? [])];

  const supabase = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });

      const forcedError = options.rpcErrors?.[fn];
      if (forcedError) {
        return { data: null, error: forcedError };
      }

      if (options.rpcResults && Object.hasOwn(options.rpcResults, fn)) {
        return { data: options.rpcResults[fn], error: null };
      }

      if (fn === 'enqueue_generation_output_import_job') {
        return { data: `output-import-${String(args.p_generation_id)}`, error: null };
      }

      if (fn === 'start_generation' || fn === 'start_template_generation') {
        const insertError = generationInsertErrors.shift();
        if (insertError) {
          return { data: null, error: insertError };
        }

        const row: GenerationRow = {
          id: `gen-${generations.length + 1}`,
          user_id: String(args.p_user_id),
          prediction_id: null,
          status: 'pending',
          output_url: null,
          model: String(args.p_model),
          category: args.p_category ? String(args.p_category) : null,
          workflow_settings: fn === 'start_template_generation'
            ? {}
            : (args.p_workflow_settings as Record<string, unknown>) ?? null,
          prompt: typeof args.p_prompt === 'string' ? args.p_prompt : undefined,
          cost: typeof args.p_cost === 'number' ? args.p_cost : undefined,
          duration: typeof args.p_duration === 'number' ? args.p_duration : undefined,
          client_request_key_hash: typeof args.p_client_request_key_hash === 'string'
            ? args.p_client_request_key_hash
            : null,
          created_at: new Date().toISOString(),
          completed_at: null,
          template_run_id: typeof args.p_template_run_id === 'string' ? args.p_template_run_id : null,
          template_run_step_id: typeof args.p_template_run_step_id === 'string' ? args.p_template_run_step_id : null,
        };
        generations.push(row);

        return {
          data: {
            status: 'started',
            generation_id: row.id,
            remaining_credits: 100,
            cost: args.p_cost,
          },
          error: null,
        };
      }

      if (fn === 'deduct_credits') {
        return { data: 100, error: null };
      }

      if (fn === 'settle_generation_failed') {
        const row = generations.find((generation) => generation.prediction_id === args.p_prediction_id);
        if (row) {
          row.status = 'failed';
          row.completed_at = typeof args.p_completed_at === 'string' ? args.p_completed_at : new Date().toISOString();
        }
        return {
          data: {
            status: row ? 'failed' : 'missing',
            generation_id: row?.id ?? null,
            refunded: Boolean(row?.cost),
          },
          error: null,
        };
      }

      if (fn === 'settle_generation_succeeded') {
        const row = generations.find((generation) => generation.prediction_id === args.p_prediction_id);
        if (!row) {
          return {
            data: { status: 'missing' },
            error: null,
          };
        }

        if (row.status === 'failed' || Boolean((row as { refunded?: boolean }).refunded)) {
          return {
            data: {
              status: 'already_failed',
              generation_id: row.id,
              output_url: row.output_url,
              refunded: Boolean((row as { refunded?: boolean }).refunded),
            },
            error: null,
          };
        }

        row.status = 'succeeded';
        row.output_url = typeof args.p_output_url === 'string' ? args.p_output_url : null;
        row.completed_at = typeof args.p_completed_at === 'string' ? args.p_completed_at : new Date().toISOString();
        if (args.p_workflow_settings && typeof args.p_workflow_settings === 'object') {
          row.workflow_settings = args.p_workflow_settings as Record<string, unknown>;
        }

        return {
          data: {
            status: 'succeeded',
            generation_id: row.id,
            output_url: row.output_url,
            refunded: false,
          },
          error: null,
        };
      }

      if (fn === 'mark_generation_submission_unknown') {
        const row = generations.find((generation) => generation.id === args.p_generation_id);
        if (!row) return { data: { status: 'missing' }, error: null };
        if (row.prediction_id) {
          return { data: { status: 'provider_task_attached', generation_id: row.id }, error: null };
        }
        if (row.status !== 'pending' || Boolean(row.refunded)) {
          return { data: { status: 'already_settled', generation_id: row.id }, error: null };
        }
        const alreadyMarked = Boolean(row.submission_unknown_at);
        row.submission_unknown_at = row.submission_unknown_at ?? new Date().toISOString();
        return {
          data: { status: alreadyMarked ? 'already_marked' : 'held', generation_id: row.id },
          error: null,
        };
      }

      if (fn === 'settle_template_generation_start_failed' || fn === 'settle_generation_start_failed') {
        const row = generations.find((generation) => generation.id === args.p_generation_id);
        if (!row) return { data: { status: 'missing' }, error: null };
        const alreadyRefunded = Boolean(row.refunded);
        row.status = 'failed';
        row.completed_at = row.completed_at ?? new Date().toISOString();
        row.refunded = true;
        row.error_message = typeof args.p_error_message === 'string' ? args.p_error_message : null;
        row.client_request_key_hash = null;
        return {
          data: {
            status: alreadyRefunded ? 'already_failed' : 'failed',
            generation_id: row.id,
            refunded: true,
            remaining_credits: 100,
          },
          error: null,
        };
      }

      if (fn === 'attach_generation_provider_task') {
        const updateError = generationUpdateErrors.shift();
        if (updateError) {
          return { data: null, error: updateError };
        }

        const row = generations.find((generation) => generation.id === args.p_generation_id);
        const predictionId = typeof args.p_prediction_id === 'string' ? args.p_prediction_id.trim() : '';
        if (!row || !predictionId) {
          return {
            data: { status: row ? 'invalid_request' : 'missing' },
            error: null,
          };
        }

        if (row.status === 'failed' || row.status === 'succeeded' || Boolean(row.refunded)) {
          return {
            data: {
              status: 'already_settled',
              generation_id: row.id,
              prediction_id: row.prediction_id,
              generation_status: row.status,
              refunded: Boolean(row.refunded),
            },
            error: null,
          };
        }

        if (row.prediction_id) {
          return {
            data: {
              status: row.prediction_id === predictionId ? 'already_attached' : 'prediction_conflict',
              generation_id: row.id,
              prediction_id: row.prediction_id,
              generation_status: row.status,
              refunded: Boolean(row.refunded),
            },
            error: null,
          };
        }

        row.prediction_id = predictionId;
        row.status = 'processing';

        return {
          data: {
            status: 'attached',
            generation_id: row.id,
            prediction_id: row.prediction_id,
            generation_status: row.status,
            refunded: false,
          },
          error: null,
        };
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
          return {
            select() {
              return {
                async single() {
                  const insertError = generationInsertErrors.shift();
                  if (insertError) {
                    return { data: null, error: insertError };
                  }

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

                  return { data: { id: row.id }, error: null };
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            async eq(column: string, value: unknown) {
              const updateError = generationUpdateErrors.shift();
              if (updateError) {
                return { data: null, error: updateError };
              }

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
    process.env.KIE_PROVIDER_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.KIE_WEBHOOK_HMAC_KEY = 'hmac-key';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://magicbooklet.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects missing callback authentication before a template credit reservation or provider request', async () => {
    const previousWebhookSecret = process.env.KIE_PROVIDER_WEBHOOK_SECRET;
    const previousHmacKey = process.env.KIE_WEBHOOK_HMAC_KEY;
    delete process.env.KIE_WEBHOOK_HMAC_KEY;
    vi.resetModules();

    try {
      const { GenerationServiceError, startImageGeneration } = await import('@/lib/generation-services');
      const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { supabase, generations, rpcCalls } = createSupabaseMock();

      const request = startImageGeneration({
        supabase,
        creditSupabase: supabase,
        userId: 'user-1',
        clientRequestKeyHash: 'c'.repeat(64),
        prompt: 'Keep this private template prompt out of diagnostics.',
        model: 'nano-banana-2',
        imageUrls: ['https://signed.example.com/reference.png?private=1'],
        privateRecipe: true,
        persistInputMedia: false,
        templateContext: { runId: 'run-1', stepId: 'step-image-1' },
      });

      await expect(request).rejects.toMatchObject({
        name: GenerationServiceError.name,
        status: 503,
        failureCode: 'service_misconfigured',
        message: expect.stringContaining('No credits were charged'),
      });
      expect(generations).toHaveLength(0);
      expect(rpcCalls).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();

      const logs = logError.mock.calls.flat().map(String).join('\n');
      expect(logs).toContain('generation_start_configuration_preflight_failed');
      expect(logs).toContain('callback_auth');
      expect(logs).not.toContain('reference.png');
      expect(logs).not.toContain('private template prompt');
    } finally {
      if (previousWebhookSecret === undefined) delete process.env.KIE_PROVIDER_WEBHOOK_SECRET;
      else process.env.KIE_PROVIDER_WEBHOOK_SECRET = previousWebhookSecret;
      if (previousHmacKey === undefined) delete process.env.KIE_WEBHOOK_HMAC_KEY;
      else process.env.KIE_WEBHOOK_HMAC_KEY = previousHmacKey;
    }
  });

  it('classifies a missing provider callback URL before reserving credits', async () => {
    const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousProviderCallbackUrl = process.env.KIE_PROVIDER_CALLBACK_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.KIE_PROVIDER_CALLBACK_URL;
    vi.resetModules();

    try {
      const { GenerationServiceError, startImageGeneration } = await import('@/lib/generation-services');
      const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { supabase, generations, rpcCalls } = createSupabaseMock();

      await expect(startImageGeneration({
        supabase,
        creditSupabase: supabase,
        userId: 'user-1',
        prompt: 'callback base verification',
        model: 'nano-banana-2',
      })).rejects.toMatchObject({
        name: GenerationServiceError.name,
        status: 503,
        failureCode: 'service_misconfigured',
      });
      expect(generations).toHaveLength(0);
      expect(rpcCalls).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(logError.mock.calls.flat().map(String).join('\n')).toContain('callback_base_url');
    } finally {
      if (previousSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
      if (previousProviderCallbackUrl === undefined) delete process.env.KIE_PROVIDER_CALLBACK_URL;
      else process.env.KIE_PROVIDER_CALLBACK_URL = previousProviderCallbackUrl;
    }
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

  it('reserves voiceover generations before provider submission and attaches the durable callback', async () => {
    const { startVoiceoverGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const { supabase, generations } = createSupabaseMock();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        status: 'pending',
        prediction_id: null,
        category: 'audio',
      });
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-callback-1' } }),
      } as Response;
    });

    const result = await startVoiceoverGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      model: 'text-to-speech-turbo-2-5',
      text: 'Notify the backend when this is ready.',
      voice: 'Rachel',
    });

    expect(result.generationId).toBe('gen-1');
    expect(generations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-callback-1',
    });
    expect(providerBody).toMatchObject({
      callBackUrl: 'https://project.supabase.co/functions/v1/kie-webhook?generationId=gen-1&secret=test-webhook-secret',
    });
  });

  it('uses the backend client to reserve voiceover generation rows after auth', async () => {
    const { startVoiceoverGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-voice-backend-reserve-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationInsertErrors: [new Error('user client cannot reserve voiceover generation rows')],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startVoiceoverGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      model: 'text-to-speech-turbo-2-5',
      text: 'Reserve this voiceover with the backend client.',
      voice: 'Rachel',
    });

    expect(result).toMatchObject({
      predictionId: 'task-voice-backend-reserve-1',
      generationId: 'gen-1',
    });
    expect(sharedGenerations[0]).toMatchObject({
      user_id: 'user-1',
      status: 'processing',
      prediction_id: 'task-voice-backend-reserve-1',
      category: 'audio',
    });
  });

  it('refunds and fails a reserved voiceover when provider submission is rejected', async () => {
    const { startVoiceoverGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 500, msg: 'Voice provider unavailable' }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startVoiceoverGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      model: 'text-to-speech-turbo-2-5',
      text: 'This start should be refunded.',
      voice: 'Rachel',
    })).rejects.toThrow('Voice provider unavailable');

    expect(rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ fn: 'start_generation' }),
      expect.objectContaining({ fn: 'settle_generation_start_failed' }),
    ]));
    expect(generations[0]).toMatchObject({
      status: 'failed',
      prediction_id: null,
    });
    expect(generations[0].completed_at).toEqual(expect.any(String));
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

  it('reserves sound-effect generations before provider submission and attaches the durable callback', async () => {
    const { startSoundEffectGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    const { supabase, generations } = createSupabaseMock();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        status: 'pending',
        prediction_id: null,
        category: 'audio',
      });
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-sfx-durable-1' } }),
      } as Response;
    });

    const result = await startSoundEffectGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A durable cinematic whoosh.',
      duration: 6,
    });

    expect(result.generationId).toBe('gen-1');
    expect(generations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-sfx-durable-1',
    });
    expect(providerBody).toMatchObject({
      callBackUrl: 'https://project.supabase.co/functions/v1/kie-webhook?generationId=gen-1&secret=test-webhook-secret',
    });
  });

  it('uses the backend client to reserve sound-effect generation rows after auth', async () => {
    const { startSoundEffectGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-sfx-backend-reserve-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationInsertErrors: [new Error('user client cannot reserve sound-effect generation rows')],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startSoundEffectGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      prompt: 'Reserve this sound effect with the backend client.',
      duration: 6,
    });

    expect(result).toMatchObject({
      predictionId: 'task-sfx-backend-reserve-1',
      generationId: 'gen-1',
    });
    expect(sharedGenerations[0]).toMatchObject({
      user_id: 'user-1',
      status: 'processing',
      prediction_id: 'task-sfx-backend-reserve-1',
      category: 'audio',
    });
  });

  it('refunds and fails a reserved sound effect when provider submission is rejected', async () => {
    const { startSoundEffectGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 500, msg: 'Sound provider unavailable' }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startSoundEffectGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'This sound should be refunded.',
      duration: 6,
    })).rejects.toThrow('Sound provider unavailable');

    expect(rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ fn: 'start_generation' }),
      expect.objectContaining({ fn: 'settle_generation_start_failed' }),
    ]));
    expect(generations[0]).toMatchObject({
      status: 'failed',
      prediction_id: null,
    });
    expect(generations[0].completed_at).toEqual(expect.any(String));
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

  it('keeps a template video recipe out of the generation row while sending it to the provider', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-template-video-1' } }),
      } as Response;
    });

    const { supabase, generations, inputMediaRows, rpcCalls, uploads } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'v'.repeat(64),
      prompt: 'Turn the rider into a spectral flaming hero.',
      model: 'kling-3.0-video',
      duration: 5,
      mode: 'std',
      aspectRatio: '9:16',
      privateRecipe: true,
      persistInputMedia: false,
      templateContext: { runId: 'run-1', stepId: 'step-video-1' },
    });

    expect(providerBody).toMatchObject({
      input: { prompt: 'Turn the rider into a spectral flaming hero.' },
    });
    expect(rpcCalls[0]).toEqual({
      fn: 'start_template_generation',
      args: expect.objectContaining({
        p_template_run_id: 'run-1',
        p_template_run_step_id: 'step-video-1',
      }),
    });
    expect(rpcCalls[0].args).not.toHaveProperty('p_prompt');
    expect(rpcCalls[0].args).not.toHaveProperty('p_workflow_settings');
    expect(generations[0]).toMatchObject({
      prompt: undefined,
      workflow_settings: {},
      template_run_id: 'run-1',
      template_run_step_id: 'step-video-1',
    });
    expect(uploads).toEqual([]);
    expect(inputMediaRows).toEqual([]);
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

  it('skips durable input snapshots when a trusted template run marks inputs ephemeral', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-ephemeral-input-1' } }),
    } as Response);

    const { supabase, uploads, inputMediaRows } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Create a private template frame.',
      model: 'nano-banana-2',
      imageUrls: ['https://signed.example.com/private-person.png'],
      persistInputMedia: false,
    });

    expect(uploads).toEqual([]);
    expect(inputMediaRows).toEqual([]);
  });

  it('keeps a template image recipe out of the generation row while sending it to the provider', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-template-image-1' } }),
      } as Response;
    });

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'i'.repeat(64),
      prompt: 'Preserve the face and add a burning supernatural helmet.',
      model: 'nano-banana-2',
      privateRecipe: true,
      persistInputMedia: false,
      templateContext: { runId: 'run-1', stepId: 'step-image-1' },
    });

    expect(providerBody).toMatchObject({
      input: { prompt: 'Preserve the face and add a burning supernatural helmet.' },
    });
    expect(rpcCalls[0]).toEqual({
      fn: 'start_template_generation',
      args: expect.objectContaining({
        p_template_run_id: 'run-1',
        p_template_run_step_id: 'step-image-1',
      }),
    });
    expect(rpcCalls[0].args).not.toHaveProperty('p_prompt');
    expect(rpcCalls[0].args).not.toHaveProperty('p_workflow_settings');
    expect(generations[0]).toMatchObject({
      prompt: undefined,
      workflow_settings: {},
      template_run_id: 'run-1',
      template_run_step_id: 'step-image-1',
    });
  });

  it('atomically refunds template starts and persists safe diagnostics when the provider rejects an upload', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        code: 422,
        msg: 'invalid image_input at https://private.example/image.png?token=private-value',
      }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'f'.repeat(64),
      prompt: 'A private creator prompt that must not reach logs.',
      model: 'nano-banana-2',
      imageUrls: ['https://signed.example.com/tiny.jpeg'],
      privateRecipe: true,
      persistInputMedia: false,
      templateContext: { runId: 'run-1', stepId: 'step-image-1' },
    })).rejects.toThrow('invalid image_input');

    const settlement = rpcCalls.find((call) => call.fn === 'settle_template_generation_start_failed');
    expect(settlement).toEqual({
      fn: 'settle_template_generation_start_failed',
      args: {
        p_generation_id: 'gen-1',
        p_error_message: 'The generation model could not read one of the uploads. Start a new run with a clear JPEG, PNG, or WebP image at least 256×256 px.',
      },
    });
    expect(generations[0]).toMatchObject({
      status: 'failed',
      prediction_id: null,
      refunded: true,
      client_request_key_hash: null,
      error_message: expect.stringContaining('256×256'),
    });

    const logs = logError.mock.calls.flat().map(String).join('\n');
    expect(logs).toContain('template_generation_start_failed_after_reservation');
    expect(logs).toContain('invalid_input_media');
    expect(logs).not.toContain('private.example');
    expect(logs).not.toContain('private-value');
    expect(logs).not.toContain('private creator prompt');
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
      callBackUrl: 'https://project.supabase.co/functions/v1/kie-webhook?generationId=gen-1&secret=test-webhook-secret',
      model: 'gpt-image-2-text-to-image',
      input: {
        prompt: 'A premium skincare product hero image.',
        aspect_ratio: '4:5',
        resolution: '2K',
      },
    });
    expect(rpcCalls[0]).toMatchObject({
      fn: 'start_generation',
      args: { p_cost: 10 },
    });
    expect(generations[0]).toMatchObject({
      model: 'gpt-image-2',
      cost: 10,
    });
    expect(generations[0].workflow_settings).toMatchObject({
      model: 'gpt-image-2',
    });
    expect(generations[0].workflow_settings).not.toHaveProperty('providerModel');
  });

  it('reserves image credits and the pending generation row with one atomic backend RPC', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-atomic-start-1' } }),
    } as Response);

    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const generationUpdates: Record<string, unknown>[] = [];
    const atomicClient = {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === 'start_generation') {
          return {
            data: {
              status: 'started',
              generation_id: 'gen-atomic-1',
              remaining_credits: 91,
              cost: args.p_cost,
            },
            error: null,
          };
        }

        if (fn === 'attach_generation_provider_task') {
          return {
            data: {
              status: 'attached',
              generation_id: args.p_generation_id,
              prediction_id: args.p_prediction_id,
            },
            error: null,
          };
        }

        throw new Error(`Unexpected generation start RPC: ${fn}.`);
      }),
      from: vi.fn((table: string) => {
        if (table !== 'generations') {
          throw new Error(`Unexpected table access: ${table}`);
        }

        return {
          insert() {
            throw new Error('Generation starts must not deduct credits and insert rows as separate app-side steps.');
          },
          update(values: Record<string, unknown>) {
            generationUpdates.push(values);
            return {
              async eq() {
                return { data: null, error: null };
              },
            };
          },
        };
      }),
    };

    const result = await startImageGeneration({
      supabase: atomicClient as never,
      creditSupabase: atomicClient as never,
      userId: 'user-1',
      clientRequestKeyHash: 'q'.repeat(64),
      prompt: 'A premium skincare product hero image.',
      model: 'nano-banana-2',
      quotedCostCredits: 9,
    });

    expect(result).toMatchObject({
      predictionId: 'task-image-atomic-start-1',
      generationId: 'gen-atomic-1',
      remainingCredits: 91,
      cost: 9,
    });
    expect(rpcCalls).toEqual([
      expect.objectContaining({
        fn: 'start_generation',
        args: expect.objectContaining({
          p_user_id: 'user-1',
          p_cost: 9,
          p_model: 'nano-banana-2',
          p_category: 'image',
          p_client_request_key_hash: 'q'.repeat(64),
        }),
      }),
      {
        fn: 'attach_generation_provider_task',
        args: {
          p_generation_id: 'gen-atomic-1',
          p_prediction_id: 'task-image-atomic-start-1',
        },
      },
    ]);
    expect(generationUpdates).toHaveLength(0);
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
    let providerBody: Record<string, unknown> | null = null;
    const { supabase, generations } = createSupabaseMock();
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
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
    expect(providerBody).toMatchObject({
      callBackUrl: 'https://project.supabase.co/functions/v1/kie-webhook?generationId=gen-1&secret=test-webhook-secret',
    });
  });

  it('uses the backend client to reserve image generation rows after auth', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-backend-reserve-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationInsertErrors: [new Error('user client cannot reserve generation rows')],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startImageGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'k'.repeat(64),
      prompt: 'A backend-reserved image generation.',
      model: 'nano-banana-2',
    });

    expect(result).toMatchObject({
      predictionId: 'task-image-backend-reserve-1',
      generationId: 'gen-1',
    });
    expect(sharedGenerations[0]).toMatchObject({
      user_id: 'user-1',
      status: 'processing',
      prediction_id: 'task-image-backend-reserve-1',
      client_request_key_hash: 'k'.repeat(64),
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
      expect.objectContaining({ fn: 'start_generation' }),
      expect.objectContaining({ fn: 'settle_generation_start_failed' }),
    ]));
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      status: 'failed',
      prediction_id: null,
      client_request_key_hash: null,
    });
    expect(generations[0].completed_at).toEqual(expect.any(String));
  });

  it('holds an image generation instead of refunding when task creation times out', async () => {
    // The F14 money bug: a 30s timeout leaves predictionId undefined exactly as
    // a definitive rejection does, but Kie may have accepted the task. Refunding
    // here loses the money twice -- on the refund, and again on the output the
    // provider bills for and whose callback we would discard as already-settled.
    const { startImageGeneration } = await import('@/lib/generation-services');
    const { ExternalServiceTimeoutError } = await import('@/lib/provider-fetch');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new ExternalServiceTimeoutError('KIE task creation', 30_000));

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'd'.repeat(64),
      prompt: 'An ambiguous submission.',
      model: 'nano-banana-2',
    })).rejects.toThrow('timed out');

    const calledRpcs = rpcCalls.map((call) => call.fn);
    expect(calledRpcs).toContain('mark_generation_submission_unknown');
    expect(calledRpcs).not.toContain('settle_generation_start_failed');

    expect(generations[0]).toMatchObject({
      status: 'pending',
      prediction_id: null,
      submission_unknown_at: expect.any(String),
    });
    expect(generations[0].refunded).toBeFalsy();
    expect(generations[0].completed_at).toBeNull();
    // Left set deliberately: the row stays in ACTIVE_START_STATUSES, so a
    // same-key resubmit replays the held generation instead of charging twice.
    expect(generations[0].client_request_key_hash).toBe('d'.repeat(64));
  });

  it('holds a generation when the provider connection resets after submission', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    const reset = new Error('socket hang up') as Error & { code: string };
    reset.code = 'ECONNRESET';
    fetchMock.mockRejectedValue(reset);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'n'.repeat(64),
      prompt: 'A submission whose response connection resets.',
      model: 'nano-banana-2',
    })).rejects.toThrow('socket hang up');

    expect(rpcCalls.map((call) => call.fn)).toContain('mark_generation_submission_unknown');
    expect(rpcCalls.map((call) => call.fn)).not.toContain('settle_generation_start_failed');
    expect(generations[0]).toMatchObject({
      status: 'pending',
      prediction_id: null,
      submission_unknown_at: expect.any(String),
    });
    expect(generations[0].refunded).toBeFalsy();
  });

  it.each([502, 504])('holds a generation when a provider gateway returns ambiguous HTTP %s', async (status) => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ msg: 'gateway lost upstream response' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: String(status).repeat(32).slice(0, 64),
      prompt: 'A submission accepted before a gateway response failure.',
      model: 'nano-banana-2',
    })).rejects.toThrow('gateway lost upstream response');

    expect(rpcCalls.map((call) => call.fn)).toContain('mark_generation_submission_unknown');
    expect(rpcCalls.map((call) => call.fn)).not.toContain('settle_generation_start_failed');
    expect(generations[0]).toMatchObject({
      status: 'pending',
      prediction_id: null,
      submission_unknown_at: expect.any(String),
    });
    expect(generations[0].refunded).toBeFalsy();
  });

  it('holds template generation credits on ambiguous network failure', async () => {
    const { startImageGeneration, getPublicGenerationStartFailure } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new TypeError('fetch failed after write'));

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    const caught = await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 't'.repeat(64),
      prompt: 'A private template submission with an ambiguous response.',
      model: 'nano-banana-2',
      templateContext: { runId: 'template-run-1', stepId: 'template-step-1' },
      privateRecipe: true,
      persistInputMedia: false,
    }).catch((error: unknown) => error);

    expect(rpcCalls.map((call) => call.fn)).toContain('mark_generation_submission_unknown');
    expect(rpcCalls.map((call) => call.fn)).not.toContain('settle_template_generation_start_failed');
    expect(generations[0]).toMatchObject({ status: 'pending' });
    expect(generations[0].refunded).toBeFalsy();
    expect(getPublicGenerationStartFailure(caught)).toMatchObject({ code: 'submission_pending' });
  });

  it('still refunds an image generation when the provider definitively rejects it', async () => {
    // The other half of the split: a provider that answered has decided, and
    // holding its rejection for 45 minutes would be a regression.
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 400, msg: 'Prompt rejected' }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A definitively rejected prompt.',
      model: 'nano-banana-2',
    })).rejects.toThrow('Prompt rejected');

    const calledRpcs = rpcCalls.map((call) => call.fn);
    expect(calledRpcs).toContain('settle_generation_start_failed');
    expect(calledRpcs).not.toContain('mark_generation_submission_unknown');
    expect(generations[0]).toMatchObject({ status: 'failed', refunded: true });
  });

  it('holds a voiceover generation on timeout too, not only the image path', async () => {
    // The refund branch is duplicated across all seven start paths. The fix
    // lives in the shared settle helper precisely so none of them can be missed;
    // a second path proves the helper is really the shared seam.
    const { startVoiceoverGeneration } = await import('@/lib/generation-services');
    const { ExternalServiceTimeoutError } = await import('@/lib/provider-fetch');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new ExternalServiceTimeoutError('KIE task creation', 30_000));

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    await expect(startVoiceoverGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      model: 'text-to-speech-turbo-2-5',
      text: 'This start should be held, not refunded.',
      voice: 'Rachel',
    })).rejects.toThrow('timed out');

    expect(rpcCalls.map((call) => call.fn)).toContain('mark_generation_submission_unknown');
    expect(generations[0]).toMatchObject({ status: 'pending', prediction_id: null });
    expect(generations[0].refunded).toBeFalsy();
  });

  it('does not promise reserved credits when something else already settled the row', async () => {
    // 'already_settled' means another path got there first, and it may have
    // refunded. Skipping the second refund is right; telling the user their
    // credits are still reserved is not.
    const { startImageGeneration, getPublicGenerationStartFailure } = await import('@/lib/generation-services');
    const { ExternalServiceTimeoutError } = await import('@/lib/provider-fetch');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new ExternalServiceTimeoutError('KIE task creation', 30_000));

    const { supabase, generations, rpcCalls } = createSupabaseMock([], {
      rpcResults: { mark_generation_submission_unknown: { status: 'already_settled' } },
    });

    const caught = await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A row settled by another path.',
      model: 'nano-banana-2',
    }).catch((error: unknown) => error);

    // No second refund...
    expect(rpcCalls.map((call) => call.fn)).not.toContain('settle_generation_start_failed');
    expect(generations[0].refunded).toBeFalsy();
    // ...but the copy falls back to the retry-friendly timeout wording rather
    // than claiming credits are reserved.
    expect(getPublicGenerationStartFailure(caught).code).toBe('provider_unavailable');
  });

  it('refunds when the hold cannot be recorded, rather than losing track of the row', async () => {
    // An unmarked held row is invisible to reconciliation and to the reaper's
    // ambiguity reporting, so the pre-existing refund is the safer residual.
    const { startImageGeneration } = await import('@/lib/generation-services');
    const { ExternalServiceTimeoutError } = await import('@/lib/provider-fetch');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new ExternalServiceTimeoutError('KIE task creation', 30_000));

    const { supabase, generations, rpcCalls } = createSupabaseMock([], {
      rpcErrors: { mark_generation_submission_unknown: { message: 'mark unavailable' } },
    });

    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A hold that could not be recorded.',
      model: 'nano-banana-2',
    })).rejects.toThrow('timed out');

    expect(rpcCalls.map((call) => call.fn)).toContain('settle_generation_start_failed');
    expect(generations[0]).toMatchObject({ status: 'failed', refunded: true });
  });

  it('uses the backend client to mark backend-reserved image starts failed when provider submission fails', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 500, msg: 'Provider unavailable' }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationUpdateErrors: [new Error('user client cannot mark failed starts')],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    await expect(startImageGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'l'.repeat(64),
      prompt: 'A provider-failed image generation.',
      model: 'nano-banana-2',
    })).rejects.toThrow('Provider unavailable');

    expect(backendClient.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ fn: 'start_generation' }),
      expect.objectContaining({ fn: 'settle_generation_start_failed' }),
    ]));
    expect(sharedGenerations[0]).toMatchObject({
      status: 'failed',
      prediction_id: null,
      client_request_key_hash: null,
    });
    expect(sharedGenerations[0].completed_at).toEqual(expect.any(String));
  });

  it('retries attaching a provider task before refunding after provider work starts', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-attach-retry-1' } }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock([], {
      generationUpdateErrors: [new Error('transient attach failure')],
    });
    const result = await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'f'.repeat(64),
      prompt: 'A premium skincare product hero image.',
      model: 'nano-banana-2',
    });

    expect(result).toMatchObject({
      predictionId: 'task-image-attach-retry-1',
      generationId: 'gen-1',
    });
    expect(rpcCalls).toEqual(expect.arrayContaining([
      {
        fn: 'attach_generation_provider_task',
        args: {
          p_generation_id: 'gen-1',
          p_prediction_id: 'task-image-attach-retry-1',
        },
      },
    ]));
    expect(rpcCalls.some((call) => call.fn === 'refund_credits')).toBe(false);
    expect(generations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-image-attach-retry-1',
      client_request_key_hash: 'f'.repeat(64),
    });
  });

  it('uses the backend client to attach provider task ids after provider work starts', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-backend-attach-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationUpdateErrors: [
        new Error('user client cannot attach provider task 1'),
        new Error('user client cannot attach provider task 2'),
        new Error('user client cannot attach provider task 3'),
      ],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startImageGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'h'.repeat(64),
      prompt: 'A durable backend-attached image generation.',
      model: 'nano-banana-2',
    });

    expect(result).toMatchObject({
      predictionId: 'task-image-backend-attach-1',
      generationId: 'gen-1',
    });
    expect(backendClient.rpcCalls).toEqual(expect.arrayContaining([
      {
        fn: 'attach_generation_provider_task',
        args: {
          p_generation_id: 'gen-1',
          p_prediction_id: 'task-image-backend-attach-1',
        },
      },
    ]));
    expect(backendClient.rpcCalls.some((call) => call.fn === 'refund_credits')).toBe(false);
    expect(sharedGenerations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-image-backend-attach-1',
      client_request_key_hash: 'h'.repeat(64),
    });
  });

  it('keeps provider-started generations charged and pending when provider task attach cannot be saved', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-attach-down-1' } }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock([], {
      generationUpdateErrors: [
        new Error('attach unavailable 1'),
        new Error('attach unavailable 2'),
        new Error('attach unavailable 3'),
      ],
    });
    await expect(startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'g'.repeat(64),
      prompt: 'A premium skincare product hero image.',
      model: 'nano-banana-2',
    })).rejects.toThrow('Failed to attach provider task to generation.');

    expect(rpcCalls.some((call) => call.fn === 'refund_credits')).toBe(false);
    expect(generations[0]).toMatchObject({
      status: 'pending',
      prediction_id: null,
      client_request_key_hash: 'g'.repeat(64),
    });
    expect(generations[0].completed_at).toBeNull();
    expect(JSON.stringify(consoleError.mock.calls)).toContain('task-image-attach-down-1');
    expect(JSON.stringify(consoleError.mock.calls)).toContain('gen-1');
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
      elements: [
        expect.objectContaining({
          handle: '@hero',
        }),
      ],
    });
    expect(generations[0].workflow_settings).not.toHaveProperty('providerModel');
  });

  it('uses Nano Banana 2 Lite with its image_urls reference contract', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-nano-lite-1' } }),
      } as Response;
    });

    const { supabase, rpcCalls } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Keep @hero and create a bright campaign draft.',
      model: 'nano-banana-2-lite',
      imageUrls: ['https://cdn.example.com/hero.png'],
      elements: [{
        id: 'element-1',
        displayName: 'Hero',
        handle: '@hero',
        storagePath: null,
        sourceGenerationId: null,
      }],
      aspectRatio: '4:5',
    });

    expect(providerBody).toMatchObject({
      model: 'nano-banana-2-lite',
      input: {
        aspect_ratio: '4:5',
        image_urls: ['https://cdn.example.com/hero.png'],
      },
    });
    expect((providerBody as unknown as { input: Record<string, unknown> }).input).not.toHaveProperty('resolution');
    expect(rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 4 } });
  });

  it('maps Seedream 5 Pro text generation to quality and provider output fields', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-seedream-pro-text-1' } }),
      } as Response;
    });

    const { supabase, rpcCalls } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A realistic multilingual skincare campaign.',
      model: 'seedream-5-pro',
      aspectRatio: '9:16',
      resolution: '2K',
      outputFormat: 'png',
    });

    expect(providerBody).toMatchObject({
      model: 'seedream/5-pro-text-to-image',
      input: {
        aspect_ratio: '9:16',
        quality: 'high',
        output_format: 'png',
        nsfw_checker: true,
      },
    });
    expect(rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 14 } });
  });

  it('uses Seedream 5 Pro edit mode and rounds its reference surcharge', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-seedream-pro-edit-1' } }),
      } as Response;
    });

    const { supabase, rpcCalls } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Combine the product and material references.',
      model: 'seedream-5-pro',
      imageUrls: ['https://cdn.example.com/product.png', 'https://cdn.example.com/material.png'],
      aspectRatio: '1:1',
      resolution: '1K',
      outputFormat: 'jpg',
    });

    expect(providerBody).toMatchObject({
      model: 'seedream/5-pro-image-to-image',
      input: {
        image_urls: ['https://cdn.example.com/product.png', 'https://cdn.example.com/material.png'],
        quality: 'basic',
        output_format: 'jpeg',
      },
    });
    expect(rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 8 } });
  });

  it('maps Seedream 5 Lite and Ideogram V3 to their provider contracts', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const providerBodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: `task-expanded-image-${providerBodies.length}` } }) } as Response;
    });

    const liteClient = createSupabaseMock();
    await startImageGeneration({
      supabase: liteClient.supabase, creditSupabase: liteClient.supabase, userId: 'user-1',
      prompt: 'A crisp editorial portrait.', model: 'seedream-5-lite', aspectRatio: '9:16', resolution: '3K', outputFormat: 'jpg',
    });
    const ideogramClient = createSupabaseMock();
    await startImageGeneration({
      supabase: ideogramClient.supabase, creditSupabase: ideogramClient.supabase, userId: 'user-1',
      prompt: 'A bold typographic launch poster.', model: 'ideogram-v3', aspectRatio: '16:9', resolution: '1K', qualityMode: 'balanced',
    });

    expect(providerBodies[0]).toMatchObject({ model: 'seedream/5-lite-text-to-image', input: { quality: 'high', output_format: 'jpeg' } });
    expect(providerBodies[1]).toMatchObject({ model: 'ideogram/v3-text-to-image', input: { rendering_speed: 'BALANCED', image_size: 'landscape_16_9' } });
    expect(liteClient.rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 5.5 } });
    expect(ideogramClient.rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 7 } });
  });

  it('uses FLUX.2 Pro text and edit provider modes', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const providerBodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: `task-flux-${providerBodies.length}` } }),
      } as Response;
    });

    const textClient = createSupabaseMock();
    await startImageGeneration({
      supabase: textClient.supabase,
      creditSupabase: textClient.supabase,
      userId: 'user-1',
      prompt: 'A photoreal product hero on reflective glass.',
      model: 'flux-2-pro',
      aspectRatio: '4:3',
      resolution: '2K',
    });

    const editClient = createSupabaseMock();
    await startImageGeneration({
      supabase: editClient.supabase,
      creditSupabase: editClient.supabase,
      userId: 'user-1',
      prompt: 'Apply the material reference to the product.',
      model: 'flux-2-pro',
      imageUrls: ['https://cdn.example.com/product.png'],
      aspectRatio: '1:1',
      resolution: '1K',
    });

    expect(providerBodies[0]).toMatchObject({
      model: 'flux-2/pro-text-to-image',
      input: { aspect_ratio: '4:3', resolution: '2K', nsfw_checker: true },
    });
    expect(providerBodies[1]).toMatchObject({
      model: 'flux-2/pro-image-to-image',
      input: { input_urls: ['https://cdn.example.com/product.png'], resolution: '1K' },
    });
    expect(textClient.rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 7 } });
    expect(editClient.rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 5 } });
  });

  it('uses the prompt-only Z-Image contract and enforces its zero-reference limit', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-z-image-1' } }),
      } as Response;
    });

    const successClient = createSupabaseMock();
    await startImageGeneration({
      supabase: successClient.supabase,
      creditSupabase: successClient.supabase,
      userId: 'user-1',
      prompt: 'A candid creator portrait in soft morning light.',
      model: 'z-image',
      aspectRatio: '3:4',
    });

    expect(providerBody).toMatchObject({
      model: 'z-image',
      input: { aspect_ratio: '3:4', nsfw_checker: true },
    });
    expect(successClient.rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 1 } });

    const rejectedClient = createSupabaseMock();
    await expect(startImageGeneration({
      supabase: rejectedClient.supabase,
      creditSupabase: rejectedClient.supabase,
      userId: 'user-1',
      prompt: 'Use this reference.',
      model: 'z-image',
      imageUrls: ['https://cdn.example.com/reference.png'],
    })).rejects.toThrow('Z-Image supports up to 0 total reference images.');
    expect(rejectedClient.rpcCalls).toHaveLength(0);
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
      callBackUrl: 'https://project.supabase.co/functions/v1/kie-webhook?generationId=gen-1&secret=test-webhook-secret',
      model: 'grok-imagine/text-to-image',
      input: {
        prompt: 'A surreal product launch poster.',
        nsfw_checker: true,
        aspect_ratio: '3:2',
        enable_pro: true,
      },
    });
    expect(rpcCalls[0]).toMatchObject({
      fn: 'start_generation',
      args: { p_cost: 5 },
    });
    expect(generations[0]).toMatchObject({
      model: 'grok-imagine-image',
      cost: 5,
    });
    expect(generations[0].workflow_settings).toMatchObject({
      qualityMode: 'quality',
    });
    expect(generations[0].workflow_settings).not.toHaveProperty('providerModel');
  });

  it('uses a provided catalog quote cost for image charging and persistence', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-image-quote-cost-1' } }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    const result = await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A quoted-cost image generation.',
      model: 'nano-banana-2',
      quotedCostCredits: 123,
    });

    expect(result.cost).toBe(123);
    expect(rpcCalls[0]).toMatchObject({
      fn: 'start_generation',
      args: { p_cost: 123 },
    });
    expect(generations[0]).toMatchObject({
      cost: 123,
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
      fn: 'start_generation',
      args: { p_cost: 4 },
    });
    expect(generations[0].workflow_settings).not.toHaveProperty('providerModel');
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

  it('uses the backend client to reserve video generation rows after auth', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-video-backend-reserve-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationInsertErrors: [new Error('user client cannot reserve video generation rows')],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startVideoGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'm'.repeat(64),
      prompt: 'A backend-reserved video generation.',
      model: 'kling-3.0-video',
      duration: 7,
      mode: 'std',
      aspectRatio: '16:9',
      sound: true,
    });

    expect(result).toMatchObject({
      predictionId: 'task-video-backend-reserve-1',
      generationId: 'gen-1',
    });
    expect(sharedGenerations[0]).toMatchObject({
      user_id: 'user-1',
      status: 'processing',
      prediction_id: 'task-video-backend-reserve-1',
      client_request_key_hash: 'm'.repeat(64),
    });
  });

  it('uses the backend client to attach video provider task ids after provider work starts', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-video-backend-attach-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationUpdateErrors: [
        new Error('user client cannot attach video provider task 1'),
        new Error('user client cannot attach video provider task 2'),
        new Error('user client cannot attach video provider task 3'),
      ],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startVideoGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'i'.repeat(64),
      prompt: 'A durable backend-attached video generation.',
      model: 'kling-3.0-video',
      duration: 7,
      mode: 'std',
      aspectRatio: '16:9',
      sound: true,
    });

    expect(result).toMatchObject({
      predictionId: 'task-video-backend-attach-1',
      generationId: 'gen-1',
    });
    expect(backendClient.rpcCalls.some((call) => call.fn === 'refund_credits')).toBe(false);
    expect(sharedGenerations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-video-backend-attach-1',
      client_request_key_hash: 'i'.repeat(64),
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
      callBackUrl: 'https://project.supabase.co/functions/v1/kie-webhook?generationId=gen-1&secret=test-webhook-secret',
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
      fn: 'start_generation',
      args: { p_cost: 10 },
    });
    expect(generations[0]).toMatchObject({
      model: 'grok-imagine-video',
      cost: 10,
      duration: 6,
    });
    expect(generations[0].workflow_settings).toMatchObject({
      model: 'grok-imagine-video',
      providerMode: 'fun',
    });
    expect(generations[0].workflow_settings).not.toHaveProperty('providerModel');
  });

  it('uses a provided catalog quote cost for video charging and persistence', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-video-quote-cost-1' } }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    const result = await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A quoted-cost video generation.',
      model: 'kling-3.0-video',
      duration: 5,
      mode: 'std',
      aspectRatio: '16:9',
      quotedCostCredits: 234,
    });

    expect(result.cost).toBe(234);
    expect(rpcCalls[0]).toMatchObject({
      fn: 'start_generation',
      args: { p_cost: 234 },
    });
    expect(generations[0]).toMatchObject({
      cost: 234,
    });
  });

  it('rejects unsupported Grok modes before deducting credits', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const { supabase, rpcCalls } = createSupabaseMock();

    await expect(startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Animate the still.',
      model: 'grok-imagine-video',
      mode: 'spicy',
      aspectRatio: '9:16',
      duration: 10,
      resolution: '720p',
      startImageUrl: 'https://cdn.example.com/start.jpg',
    })).rejects.toThrow('Unsupported mode for Grok Imagine Video');

    expect(rpcCalls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
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

  it('rejects motion generation before charging when the provider webhook secret is missing', async () => {
    delete process.env.KIE_PROVIDER_WEBHOOK_SECRET;
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
    })).rejects.toMatchObject({
      status: 503,
      failureCode: 'service_misconfigured',
      message: expect.stringContaining('No credits were charged'),
    });

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

  it('uses the backend client to reserve motion generation rows after auth', async () => {
    const { startMotionGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-motion-backend-reserve-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationInsertErrors: [new Error('user client cannot reserve motion generation rows')],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startMotionGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'n'.repeat(64),
      prompt: 'A backend-reserved motion generation.',
      model: 'kling-2.6',
      referenceVideoUrl: 'https://cdn.example.com/reference.mp4',
      characterImageUrl: 'https://cdn.example.com/character.png',
      duration: 10,
      characterOrientation: 'video',
      mode: '720p',
    });

    expect(result).toMatchObject({
      predictionId: 'task-motion-backend-reserve-1',
      generationId: 'gen-1',
    });
    expect(sharedGenerations[0]).toMatchObject({
      user_id: 'user-1',
      status: 'processing',
      prediction_id: 'task-motion-backend-reserve-1',
      client_request_key_hash: 'n'.repeat(64),
    });
  });

  it('uses the backend client to attach motion provider task ids after provider work starts', async () => {
    const { startMotionGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-motion-backend-attach-1' } }),
    } as Response);

    const sharedGenerations: GenerationRow[] = [];
    const userClient = createSupabaseMock([], {
      sharedGenerations,
      generationUpdateErrors: [
        new Error('user client cannot attach motion provider task 1'),
        new Error('user client cannot attach motion provider task 2'),
        new Error('user client cannot attach motion provider task 3'),
      ],
    });
    const backendClient = createSupabaseMock([], { sharedGenerations });

    const result = await startMotionGeneration({
      supabase: userClient.supabase,
      creditSupabase: backendClient.supabase,
      userId: 'user-1',
      clientRequestKeyHash: 'j'.repeat(64),
      prompt: 'A durable backend-attached motion generation.',
      model: 'kling-2.6',
      referenceVideoUrl: 'https://cdn.example.com/reference.mp4',
      characterImageUrl: 'https://cdn.example.com/character.png',
      duration: 10,
      characterOrientation: 'video',
      mode: '720p',
    });

    expect(result).toMatchObject({
      predictionId: 'task-motion-backend-attach-1',
      generationId: 'gen-1',
    });
    expect(backendClient.rpcCalls.some((call) => call.fn === 'refund_credits')).toBe(false);
    expect(sharedGenerations[0]).toMatchObject({
      status: 'processing',
      prediction_id: 'task-motion-backend-attach-1',
      client_request_key_hash: 'j'.repeat(64),
    });
  });

  it('uses a provided catalog quote cost for motion charging and persistence', async () => {
    const { startMotionGeneration } = await import('@/lib/generation-services');
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 200, data: { taskId: 'task-motion-quote-cost-1' } }),
    } as Response);

    const { supabase, generations, rpcCalls } = createSupabaseMock();
    const result = await startMotionGeneration({
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
      quotedCostCredits: 345,
    });

    expect(result.cost).toBe(345);
    expect(rpcCalls[0]).toMatchObject({
      fn: 'start_generation',
      args: { p_cost: 345 },
    });
    expect(generations[0]).toMatchObject({
      cost: 345,
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

  it('bounds provider task creation calls with a timeout signal', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let providerInit: RequestInit | undefined;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerInit = init;
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-image-timeout-1' } }),
      } as Response;
    });

    const { supabase } = createSupabaseMock();
    await startImageGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A compact product render.',
      model: 'nano-banana-2',
    });

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(providerInit?.signal).toBe(timeoutSignal);
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
    expect(generations[0].cost).toBe(108);
    expect(generations[0].workflow_settings).toMatchObject({
      referenceVideoUrls: ['asset-video-1'],
      referenceAudioUrls: ['asset-audio-1'],
      seedanceAssets: {
        images: [expect.objectContaining({ assetId: 'asset-image-1' })],
      },
    });
  });

  it('passes Seedance 2 4K output through to Kie with the matching quote', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ code: 200, data: { taskId: 'task-seedance-4k-1' } }),
      } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A polished vertical creator ad.',
      model: 'seedance-2',
      duration: 7,
      aspectRatio: '9:16',
      resolution: '4k',
    });

    expect(providerBody).toMatchObject({
      model: 'bytedance/seedance-2',
      input: {
        resolution: '4k',
        aspect_ratio: '9:16',
        duration: 7,
      },
    });
    expect(generations[0].cost).toBe(1456);
  });

  it('keeps Seedance frame guidance separate from reusable references', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const providerBodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'task-seedance-frames-1' } }) } as Response;
    });

    const { supabase } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Transition between the supplied compositions.',
      model: 'seedance-2-mini',
      duration: 6,
      aspectRatio: '16:9',
      resolution: '720p',
      referenceMode: 'frames',
      startImageUrl: 'https://cdn.example.com/start.jpg',
      endImageUrl: 'https://cdn.example.com/end.jpg',
    });

    expect(providerBodies[0]).toMatchObject({
      model: 'bytedance/seedance-2-mini',
      input: {
        first_frame_url: 'https://cdn.example.com/start.jpg',
        last_frame_url: 'https://cdn.example.com/end.jpg',
      },
    });
    expect((providerBodies[0] as { input: Record<string, unknown> }).input).not.toHaveProperty('reference_image_urls');
  });

  it('routes Kling 3 Turbo between text and image endpoints', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const providerBodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: `task-kling-turbo-${providerBodies.length}` } }) } as Response;
    });

    const { supabase } = createSupabaseMock();
    await startVideoGeneration({
      supabase, creditSupabase: supabase, userId: 'user-1', prompt: 'A camera glides through a gallery.',
      model: 'kling-3.0-turbo', duration: 5, aspectRatio: '16:9', resolution: '720p',
    });
    await startVideoGeneration({
      supabase, creditSupabase: supabase, userId: 'user-1', prompt: 'Animate this portrait.',
      model: 'kling-3.0-turbo', duration: 5, aspectRatio: '9:16', resolution: '1080p',
      startImageUrl: 'https://cdn.example.com/portrait.jpg',
    });

    expect(providerBodies[0]).toMatchObject({ model: 'kling/v3-turbo-text-to-video', input: { aspect_ratio: '16:9' } });
    expect(providerBodies[1]).toMatchObject({ model: 'kling/v3-turbo-image-to-video', input: { image_urls: ['https://cdn.example.com/portrait.jpg'] } });
  });

  it('routes Wan 2.7 reusable media through reference-to-video', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'task-wan-r2v-1' } }) } as Response;
    });

    const { supabase } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Keep the product consistent while matching the movement.',
      model: 'wan-2.7',
      duration: 5,
      aspectRatio: '9:16',
      resolution: '1080p',
      referenceMode: 'elements',
      startImageUrl: 'https://cdn.example.com/first-frame.jpg',
      imageUrls: ['https://cdn.example.com/product.jpg'],
      referenceVideoUrls: ['https://cdn.example.com/motion.mp4'],
      referenceAudioUrls: ['https://cdn.example.com/voice.wav'],
    });

    expect(providerBody).toMatchObject({
      model: 'wan/2-7-r2v',
      input: {
        reference_image: ['https://cdn.example.com/product.jpg'],
        reference_video: ['https://cdn.example.com/motion.mp4'],
        first_frame: 'https://cdn.example.com/first-frame.jpg',
        reference_voice: 'https://cdn.example.com/voice.wav',
        aspect_ratio: '9:16',
      },
    });
  });

  it('routes HappyHorse and Gemini Omni through their reference endpoints', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const providerBodies: Record<string, unknown>[] = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBodies.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: `task-expanded-video-${providerBodies.length}` } }) } as Response;
    });

    const happyClient = createSupabaseMock();
    await startVideoGeneration({
      supabase: happyClient.supabase, creditSupabase: happyClient.supabase, userId: 'user-1',
      prompt: 'Keep the character consistent.', model: 'happyhorse-1.1', duration: 5,
      aspectRatio: '9:16', resolution: '720p', referenceMode: 'elements',
      imageUrls: ['https://cdn.example.com/character.jpg'],
    });
    const geminiClient = createSupabaseMock();
    await startVideoGeneration({
      supabase: geminiClient.supabase, creditSupabase: geminiClient.supabase, userId: 'user-1',
      prompt: 'Use the clip as motion guidance.', model: 'gemini-omni-video', duration: 8,
      aspectRatio: '16:9', resolution: '4k', referenceMode: 'elements',
      imageUrls: ['https://cdn.example.com/product.jpg'],
      referenceVideoUrls: ['https://cdn.example.com/motion.mp4'],
      preparedAudioIds: ['voice-prepared-1'],
      characterIds: ['character-prepared-1'],
    });

    expect(providerBodies[0]).toMatchObject({ model: 'happyhorse-1-1/reference-to-video', input: { reference_image: ['https://cdn.example.com/character.jpg'] } });
    expect(providerBodies[1]).toMatchObject({
      model: 'gemini-omni-video',
      input: {
        image_urls: ['https://cdn.example.com/product.jpg'],
        video_list: [{ url: 'https://cdn.example.com/motion.mp4', start: 0, ends: 8 }],
        audio_ids: ['voice-prepared-1'],
        character_ids: ['character-prepared-1'],
      },
    });
    expect(happyClient.rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 113 } });
    expect(geminiClient.rpcCalls[0]).toMatchObject({ fn: 'start_generation', args: { p_cost: 252 } });
  });

  it('submits Hailuo 2.3 with its required start image and provider mode', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'task-hailuo-1' } }) } as Response;
    });

    const { supabase } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Add a subtle cinematic push in.',
      model: 'hailuo-2.3',
      duration: 6,
      mode: 'pro',
      aspectRatio: 'Auto',
      resolution: '1080P',
      startImageUrl: 'https://cdn.example.com/keyframe.jpg',
    });

    expect(providerBody).toMatchObject({
      model: 'hailuo/2-3-image-to-video-pro',
      input: {
        image_url: 'https://cdn.example.com/keyframe.jpg',
        duration: '6',
        resolution: '1080P',
      },
    });
  });

  it('sends Veo Lite with the selected resolution', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    let providerBody: Record<string, unknown> | null = null;
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'task-veo-lite-1' } }) } as Response;
    });

    const { supabase, generations } = createSupabaseMock();
    await startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'A calm ocean at sunrise.',
      model: 'veo-3.1',
      mode: 'veo3_lite',
      aspectRatio: '16:9',
      resolution: '1080p',
    });

    // veo names this field `aspect_ratio`, unlike its camelCase neighbours.
    // Sending `aspectRatio` meant veo never received a ratio and silently used
    // its 16:9 default, so assert the wire key and not just the value.
    expect(providerBody).toMatchObject({
      model: 'veo3_lite',
      resolution: '1080p',
      generationType: 'TEXT_2_VIDEO',
      aspect_ratio: '16:9',
    });
    expect(providerBody).not.toHaveProperty('aspectRatio');
    expect(generations[0].cost).toBe(35);
  });

  it('refuses reference images on Veo Quality, which cannot do REFERENCE_2_VIDEO', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    vi.mocked(fetch).mockClear();

    const { supabase } = createSupabaseMock();
    // Only veo3_fast and veo3_lite accept REFERENCE_2_VIDEO; the flagship veo3
    // does not. The catalog declares this rule, but nothing pinned it on the
    // start path, so this asserts the request is actually refused end to end
    // rather than reaching the provider as a paid-for request.
    await expect(startVideoGeneration({
      supabase,
      creditSupabase: supabase,
      userId: 'user-1',
      prompt: 'Use the supplied character reference.',
      model: 'veo-3.1',
      mode: 'veo3',
      aspectRatio: '16:9',
      resolution: '720p',
      references: [
        {
          url: 'asset-image-1',
          handle: '@hero',
          displayName: 'Hero',
          storagePath: 'uploads/user-1/hero.png',
          sourceGenerationId: null,
        },
      ],
    })).rejects.toThrow('Reusable references require Veo Lite or Fast.');

    // Rejected before any provider call, so no hold is placed for a request the
    // provider would refuse.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('queues processing audio outputs without downloading media in the status poll', async () => {
    const { syncGenerationStatuses } = await import('@/lib/generation-status-sync');
    const statusSignal = AbortSignal.abort();
    const mediaSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(statusSignal)
      .mockReturnValueOnce(mediaSignal);
    let statusInit: RequestInit | undefined;
    let mediaInit: RequestInit | undefined;
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        statusInit = init;
        return {
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
        } as Response;
      })
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        mediaInit = init;
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      });

    const { supabase, generations, uploads, rpcCalls } = createSupabaseMock([{
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

    expect(generations[0].status).toBe('processing');
    expect(generations[0].output_url).toBeNull();
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 10_000);
    expect(statusInit?.signal).toBe(statusSignal);
    expect(mediaInit).toBeUndefined();
    expect(uploads).toEqual([]);
    expect(rpcCalls).toContainEqual({
      fn: 'enqueue_generation_output_import_job',
      args: expect.objectContaining({
        p_generation_id: 'gen-audio-1',
        p_output_urls: ['https://cdn.example.com/audio.mp3'],
        p_provider_completed_at: '2026-04-15T10:00:12.000Z',
      }),
    });
  });

  it('bounds provider status polling calls with a timeout signal', async () => {
    const { syncGenerationStatuses } = await import('@/lib/generation-status-sync');
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    let providerInit: RequestInit | undefined;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      providerInit = init;
      return {
        ok: true,
        json: async () => ({
          code: 200,
          data: {
            state: 'waiting',
            createTime: '2026-04-15T10:00:00.000Z',
          },
        }),
      } as Response;
    });

    const { supabase } = createSupabaseMock([{
      id: 'gen-status-timeout-1',
      user_id: 'user-1',
      prediction_id: 'task-status-timeout-1',
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
      generationIds: ['gen-status-timeout-1'],
    });

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(providerInit?.signal).toBe(timeoutSignal);
  });

  it('settles failed async generations with one atomic backend RPC', async () => {
    const { syncGenerationStatuses } = await import('@/lib/generation-status-sync');
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
    expect(rpcCalls).toContainEqual({
      fn: 'settle_generation_failed',
      args: {
        p_prediction_id: 'task-audio-2',
        p_completed_at: '2026-04-15T10:01:00.000Z',
      },
    });
    expect(rpcCalls.some((call) => call.fn === 'refund_generation')).toBe(false);
  });

  it('syncs one generation by provider task id for webhook completion jobs', async () => {
    const { syncGenerationStatusByPredictionId } = await import('@/lib/generation-status-sync');
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
    expect(rpcCalls).toContainEqual({
      fn: 'settle_generation_failed',
      args: {
        p_prediction_id: 'task-audio-3',
        p_completed_at: '2026-04-15T10:02:00.000Z',
      },
    });
    expect(rpcCalls.some((call) => call.fn === 'refund_generation')).toBe(false);
  });

  it('applies terminal webhook failure payloads without polling provider status', async () => {
    const { syncGenerationStatusByPredictionId } = await import('@/lib/generation-status-sync');
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
    expect(rpcCalls).toContainEqual({
      fn: 'settle_generation_failed',
      args: {
        p_prediction_id: 'task-webhook-fail-1',
        p_completed_at: '2026-04-15T10:03:00.000Z',
      },
    });
    expect(rpcCalls.some((call) => call.fn === 'refund_generation')).toBe(false);
  });
});
