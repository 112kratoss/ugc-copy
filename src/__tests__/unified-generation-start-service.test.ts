import { describe, expect, it, vi } from 'vitest';

import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { GenerationModelCatalogSchemaUnavailableError } from '@/lib/generation-model-catalog-store';
import {
  ReferenceDurationChangedError,
  UnifiedGenerationRequestError,
  buildUnifiedGenerationQuoteInput,
  buildUnifiedGenerationQuoteInputForCatalog,
  dispatchCatalogGenerationAdapter,
  durationBoundInputSlots,
  loadUnifiedGenerationCatalog,
  parseUnifiedGenerationRequest,
  resolveBillableInputDurations,
  startUnifiedGenerationForRoute,
} from '@/lib/unified-generation-start-service';

describe('unified generation start service', () => {
  it('requires the client catalog revision and keeps model IDs open-ended', () => {
    expect(() => parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'remotely-published-model',
      settings: {},
    })).toThrow(UnifiedGenerationRequestError);

    expect(parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'remotely-published-model',
      catalogRevision: 'release-revision-2',
      settings: { resolution: '1080p' },
    })).toMatchObject({
      modelId: 'remotely-published-model',
      catalogRevision: 'release-revision-2',
    });
  });

  it('derives slot counts and reference-video duration metadata from assets', () => {
    const parsed = parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'seedance-2',
      catalogRevision: 'seedance-release',
      settings: { duration: 7, resolution: '4k' },
      inputs: [
        {
          slot: 'videoReferences',
          kind: 'video',
          url: 'uploads/user/reference-1.mp4',
          durationSeconds: 4.25,
        },
        {
          slot: 'videoReferences',
          kind: 'video',
          url: 'uploads/user/reference-2.mp4',
          durationSeconds: 2.75,
        },
      ],
    });

    expect(buildUnifiedGenerationQuoteInput(parsed)).toMatchObject({
      inputCounts: { videos: 2 },
      inputMetadata: {
        slots: {
          videoReferences: {
            count: 2,
            durationsSeconds: [4.25, 2.75],
          },
        },
        referenceVideoDurationsSeconds: [4.25, 2.75],
      },
    });
  });

  it('uses only the authoritative v1 release during the rolling v2 publication window', async () => {
    const snapshot = {
      catalog: {
        schemaVersion: 1,
        revision: 'catalog-v1',
        defaults: { image: null, video: 'seedance-2', motion: null },
        models: [],
      },
      operations: new Map(),
      source: 'database' as const,
      releaseId: 'release-v1',
      releaseSchemaVersion: 1,
    };
    const loadCatalog = vi.fn()
      .mockRejectedValueOnce(new GenerationModelCatalogSchemaUnavailableError(2, 1))
      .mockResolvedValueOnce(snapshot);

    await expect(loadUnifiedGenerationCatalog(loadCatalog, 'mobile')).resolves.toBe(snapshot);
    expect(loadCatalog).toHaveBeenNthCalledWith(1, { platform: 'mobile', schemaVersion: 2 });
    expect(loadCatalog).toHaveBeenNthCalledWith(2, { platform: 'mobile', schemaVersion: 1 });

    const parsed = parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'seedance-2',
      catalogRevision: 'catalog-v1',
      settings: { referenceMode: 'elements', duration: 7, resolution: '720p' },
      inputs: [{
        slot: 'videoReferences',
        kind: 'video',
        url: 'uploads/user/reference.mp4',
        durationSeconds: 3,
      }],
    });
    expect(buildUnifiedGenerationQuoteInputForCatalog(parsed, snapshot)).toMatchObject({
      schemaVersion: 1,
      inputMetadata: {
        referenceVideoDurationsSeconds: [3],
      },
    });
    expect(buildUnifiedGenerationQuoteInputForCatalog(parsed, snapshot).inputMetadata?.slots)
      .toBeUndefined();
  });

  it('does not fall back when the authoritative catalog fails for another reason', async () => {
    const loadCatalog = vi.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(loadUnifiedGenerationCatalog(loadCatalog, 'web'))
      .rejects.toThrow('database unavailable');
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it('dispatches a catalog-only model through the generic allowlisted adapter', async () => {
    const startCatalog = vi.fn(async () => ({
      predictionId: 'provider-task-1',
      generationId: 'generation-1',
      remainingCredits: 90,
      cost: 10,
    }));
    const startImage = vi.fn();
    const startVideo = vi.fn();
    const startMotion = vi.fn();
    const request = parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'catalog-only-video',
      catalogRevision: 'catalog-v2',
      prompt: 'A lighthouse in a storm',
      settings: { duration: 5 },
    });

    const result = await dispatchCatalogGenerationAdapter({
      request,
      quote: {
        modelId: 'catalog-only-video',
        catalogRevision: 'catalog-v2',
        normalizedSettings: { duration: 5 },
        costCredits: 10,
      },
      operation: {
        modelId: 'catalog-only-video',
        kind: 'video',
        adapterKey: 'kie-task-v1',
        providerModelMap: { default: 'provider/catalog-only-video' },
        adapterConfig: {
          settings: {
            duration: { field: 'duration', transform: 'integer' },
          },
        },
        pricingStrategy: 'flat',
        pricingConfig: { credits: 10 },
        validationStrategy: 'descriptor-rules-v1',
        validationConfig: {},
        verificationConfig: {},
      },
      supabase: {} as never,
      adminSupabase: {} as never,
      userId: 'user-1',
      clientRequestKeyHash: 'request-hash',
      sourceGenerationId: null,
      dependencies: {
        startCatalog,
        startImage,
        startVideo,
        startMotion,
      },
    });

    expect(result).toMatchObject({
      predictionId: 'provider-task-1',
      cost: 10,
    });
    expect(startCatalog).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({
        modelId: 'catalog-only-video',
        adapterKey: 'kie-task-v1',
      }),
      quotedCostCredits: 10,
    }));
    expect(startImage).not.toHaveBeenCalled();
    expect(startVideo).not.toHaveBeenCalled();
    expect(startMotion).not.toHaveBeenCalled();
  });

  it('groups subjectImages slot assets into Kling O3 named subjects by handle', async () => {
    const startVideo = vi.fn(async () => ({
      predictionId: 'provider-task-o3',
      generationId: 'generation-o3',
      remainingCredits: 10,
      cost: 70,
    }));
    const request = parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'kling-o3',
      catalogRevision: 'catalog-v2',
      prompt: '@hero lifts the serum and smiles.',
      settings: { duration: 5, resolution: '720p', referenceMode: 'subjects' },
      inputs: [
        { slot: 'subjectImages', kind: 'image', url: 'https://cdn.example.com/hero-a.jpg', label: 'Hero creator', handle: '@hero' },
        { slot: 'subjectImages', kind: 'image', url: 'https://cdn.example.com/hero-b.jpg', label: 'Hero creator', handle: '@hero', storagePath: 'uploads/user/hero-b.jpg' },
      ],
    });

    await dispatchCatalogGenerationAdapter({
      request,
      quote: {
        modelId: 'kling-o3',
        catalogRevision: 'catalog-v2',
        normalizedSettings: { duration: 5, resolution: '720p', referenceMode: 'subjects' },
        costCredits: 70,
      },
      operation: {
        modelId: 'kling-o3',
        kind: 'video',
        adapterKey: 'video-v1',
        providerModelMap: {},
        adapterConfig: {},
        pricingStrategy: 'flat',
        pricingConfig: { credits: 70 },
        validationStrategy: 'descriptor-rules-v1',
        validationConfig: {},
        verificationConfig: {},
      },
      supabase: {} as never,
      adminSupabase: {} as never,
      userId: 'user-1',
      clientRequestKeyHash: 'request-hash',
      sourceGenerationId: null,
      dependencies: {
        startCatalog: vi.fn(),
        startImage: vi.fn(),
        startVideo,
        startMotion: vi.fn(),
      },
    });

    expect(startVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'kling-o3',
      klingSubjects: [
        {
          handle: '@hero',
          displayName: 'Hero creator',
          images: [
            { url: 'https://cdn.example.com/hero-a.jpg', storagePath: null },
            { url: 'https://cdn.example.com/hero-b.jpg', storagePath: 'uploads/user/hero-b.jpg' },
          ],
        },
      ],
      // Subject images never leak into the flat reference mappings.
      imageUrls: [],
      elements: [],
      elementImageUrls: [],
    }));
  });

  it('rate limits before resolving the remix source or looking up attempts', async () => {
    // Grants on generations only allow service-role reads of is_public, so the
    // route must hand resolveSource the admin client — passing the user client
    // is the regression that broke every remix-sourced start in production.
    const userSupabase = { label: 'user-client' };
    const adminSupabase = { label: 'admin-client' };
    const rateLimitStop = new Error('stop-before-idempotency');

    const snapshot = {
      catalog: {
        schemaVersion: 2,
        revision: 'catalog-v2',
        defaults: { image: null, video: 'catalog-only-video', motion: null },
        models: [],
      },
      operations: new Map([['catalog-only-video', {
        modelId: 'catalog-only-video',
        kind: 'video',
        adapterKey: 'kie-task-v1',
        providerModelMap: { default: 'provider/catalog-only-video' },
        adapterConfig: {},
        pricingStrategy: 'flat',
        pricingConfig: { credits: 10 },
        validationStrategy: 'descriptor-rules-v1',
        validationConfig: {},
        verificationConfig: {},
      }]]),
      source: 'database' as const,
      releaseId: 'release-v2',
      releaseSchemaVersion: 2,
    };
    // Typed as a tuple so the argument assertions below can index it.
    const resolveSource = vi.fn(async (..._args: [unknown, string, unknown]) => {
      void _args;
      return null;
    });

    await expect(startUnifiedGenerationForRoute(
      {
        request: new Request('http://localhost/api/generations'),
        body: {
          kind: 'video',
          modelId: 'catalog-only-video',
          catalogRevision: 'catalog-v2',
          prompt: 'A lighthouse in a storm',
          settings: { duration: 5 },
          sourceGenerationId: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
        },
        userId: 'user-1',
        supabase: userSupabase as never,
        adminSupabase: adminSupabase as never,
      },
      {
        loadCatalog: vi.fn(async () => snapshot) as never,
        quoteModel: vi.fn(() => ({
          modelId: 'catalog-only-video',
          catalogRevision: 'catalog-v2',
          normalizedSettings: { duration: 5 },
          costCredits: 10,
        })) as never,
        resolveSource,
        enforceRateLimit: vi.fn(async () => {
          throw rateLimitStop;
        }) as never,
      },
    )).rejects.toBe(rateLimitStop);

    expect(resolveSource).not.toHaveBeenCalled();
  });
});

describe('reference lengths a caller reports', () => {
  const REFERENCE_URL = 'https://media.example.supabase.co/storage/v1/object/sign/generation_inputs/user-1/reference.mp4?token=signed';
  const CHARACTER_URL = 'https://media.example.supabase.co/storage/v1/object/sign/generation_inputs/user-1/character.png?token=signed';

  const SEEDANCE_OPERATION = {
    modelId: 'seedance-2',
    kind: 'video' as const,
    adapterKey: 'video-v1' as const,
    providerModelMap: {},
    adapterConfig: {},
    pricingStrategy: 'reference-adjustment' as const,
    pricingConfig: {
      unit: 'second',
      settingKey: 'resolution',
      durationSettingKey: 'duration',
      referenceDurationSlots: ['videoReferences'],
      rounding: 'ceil',
      rates: { noReference: { '720p': 8 }, withReference: { '720p': 10 } },
    },
    validationStrategy: 'descriptor-rules-v1' as const,
    validationConfig: {},
    verificationConfig: {},
  };

  const MOTION_OPERATION = {
    ...SEEDANCE_OPERATION,
    modelId: 'kling-2.6',
    kind: 'motion' as const,
    adapterKey: 'motion-v1' as const,
    pricingStrategy: 'per-second' as const,
    pricingConfig: { durationSettingKey: 'duration', rate: 10 },
  };

  function seedanceBody(durationSeconds: number | null) {
    return {
      kind: 'video',
      modelId: 'seedance-2',
      catalogRevision: 'catalog-v2',
      prompt: 'Follow the reference motion.',
      settings: { duration: 5, resolution: '720p' },
      inputs: [{ slot: 'videoReferences', kind: 'video', url: REFERENCE_URL, durationSeconds }],
    };
  }

  function motionBody(duration: number, durationSeconds: number) {
    return {
      kind: 'motion',
      modelId: 'kling-2.6',
      catalogRevision: 'catalog-v2',
      prompt: '',
      settings: { duration, resolution: '720p', characterOrientation: 'video' },
      inputs: [
        { slot: 'characterImage', kind: 'image', url: CHARACTER_URL },
        { slot: 'referenceVideo', kind: 'video', url: REFERENCE_URL, durationSeconds },
      ],
    };
  }

  /** Prices the way reference-adjustment does: (output + reference seconds) x rate. */
  function referencePricedQuote(input: GenerationModelQuoteInput) {
    const referenceSeconds = (input.inputMetadata?.referenceVideoDurationsSeconds ?? [])
      .reduce((total, seconds) => total + seconds, 0);
    return {
      modelId: input.modelId,
      catalogRevision: 'catalog-v2',
      normalizedSettings: input.settings ?? {},
      costCredits: Math.ceil((Number(input.settings?.duration ?? 0) + referenceSeconds) * 10),
    };
  }

  /** Prices the way a per-second motion model does: its duration setting x rate. */
  function durationPricedQuote(input: GenerationModelQuoteInput) {
    return {
      modelId: input.modelId,
      catalogRevision: 'catalog-v2',
      normalizedSettings: input.settings ?? {},
      costCredits: Number(input.settings?.duration ?? 0) * 10,
    };
  }

  /** Just enough of the service client for the idempotent start: a claim, a lock, and the replay lookup. */
  function createAdminClient(existingGeneration: Record<string, unknown> | null) {
    return {
      rpc: vi.fn(async (fn: string) => (
        fn === 'claim_generation_start_request'
          ? { data: 'claimed', error: null }
          : { data: true, error: null }
      )),
      from: vi.fn((table: string) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: table === 'generations' ? existingGeneration : { credits: 90 },
            error: null,
          }),
        };
        return builder;
      }),
    };
  }

  function start({
    body,
    measuredSeconds,
    operation = SEEDANCE_OPERATION,
    quote = referencePricedQuote,
    existingGeneration = null,
  }: {
    body: Record<string, unknown>;
    measuredSeconds: number;
    operation?: typeof SEEDANCE_OPERATION | typeof MOTION_OPERATION;
    quote?: (input: GenerationModelQuoteInput) => ReturnType<typeof referencePricedQuote>;
    existingGeneration?: Record<string, unknown> | null;
  }) {
    const started = { predictionId: 'provider-task', generationId: 'generation-1', remainingCredits: 50, cost: 0 };
    const startVideo = vi.fn(async () => started);
    const startMotion = vi.fn(async () => started);
    const probeInputDuration = vi.fn(async () => measuredSeconds);
    const outcome = startUnifiedGenerationForRoute(
      {
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': 'reference-length-key' },
        }),
        body,
        userId: 'user-1',
        supabase: { label: 'user-client' } as never,
        adminSupabase: createAdminClient(existingGeneration) as never,
      },
      {
        loadCatalog: vi.fn(async () => ({
          catalog: {
            schemaVersion: 2,
            revision: 'catalog-v2',
            defaults: { image: null, video: 'seedance-2', motion: 'kling-2.6' },
            models: [],
          },
          operations: new Map([[operation.modelId, operation]]),
          source: 'database' as const,
          releaseId: 'release-v2',
          releaseSchemaVersion: 2,
        })) as never,
        quoteModel: vi.fn(quote) as never,
        resolveSource: vi.fn(async () => null) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
        startVideo: startVideo as never,
        startMotion: startMotion as never,
        resolveInputSource: vi.fn(async (_client: unknown, url: string) => url),
        probeInputDuration,
      },
    );
    return { outcome, startVideo, startMotion, probeInputDuration };
  }

  // Audit A2, counterexample 2: the same reference file cost less when its
  // length was reported as zero seconds instead of ten.
  it('charges what a reference really runs, whatever length the caller reports', async () => {
    const honest = start({ body: seedanceBody(10), measuredSeconds: 10 });
    await expect(honest.outcome).resolves.toMatchObject({ success: true, predictionId: 'provider-task' });
    expect(honest.startVideo).toHaveBeenCalledWith(expect.objectContaining({
      quotedCostCredits: 150,
      referenceVideoUrls: [REFERENCE_URL],
    }));

    const understated = start({ body: seedanceBody(0), measuredSeconds: 10 });
    const refusal = await understated.outcome.then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReferenceDurationChangedError);
    expect(refusal).toMatchObject({
      status: 409,
      code: 'REFERENCE_DURATION_CHANGED',
      quotedCostCredits: 50,
      costCredits: 150,
      inputs: [{ index: 0, slot: 'videoReferences', durationSeconds: 10 }],
    });
    expect(understated.startVideo).not.toHaveBeenCalled();
  });

  it('uses measured duration even when the reported length is within half a second', async () => {
    const run = start({ body: seedanceBody(9.5), measuredSeconds: 10 });
    await expect(run.outcome).rejects.toMatchObject({
      code: 'REFERENCE_DURATION_CHANGED', quotedCostCredits: 145, costCredits: 150,
    });
    expect(run.startVideo).not.toHaveBeenCalled();
  });

  it('replays an accepted attempt before a changed catalog can reject its old revision', async () => {
    const run = start({
      body: seedanceBody(10), measuredSeconds: 10,
      existingGeneration: { id: 'generation-1', prediction_id: 'original-task', status: 'processing', cost: 150 },
      quote: () => { throw new Error('CATALOG_CHANGED'); },
    });
    await expect(run.outcome).resolves.toMatchObject({ predictionId: 'original-task', idempotentReplay: true, catalogRevision: 'catalog-v2' });
    expect(run.startVideo).not.toHaveBeenCalled();
    expect(run.probeInputDuration).not.toHaveBeenCalled();
  });

  it('requires reconfirmation when fractional measured seconds raise the cost', async () => {
    const { outcome, startVideo } = start({ body: seedanceBody(9.75), measuredSeconds: 10.25 });

    await expect(outcome).rejects.toMatchObject({
      code: 'REFERENCE_DURATION_CHANGED', quotedCostCredits: 148, costCredits: 153,
    });
    expect(startVideo).not.toHaveBeenCalled();
  });

  it('charges the measured length when the caller overstated it', async () => {
    const { outcome, startVideo } = start({ body: seedanceBody(14), measuredSeconds: 10 });

    await expect(outcome).resolves.toMatchObject({ success: true });
    expect(startVideo).toHaveBeenCalledWith(expect.objectContaining({ quotedCostCredits: 150 }));
  });

  it('refuses a combined length over the model cap once it is measured', async () => {
    const cappedQuote = (input: GenerationModelQuoteInput) => {
      const total = (input.inputMetadata?.referenceVideoDurationsSeconds ?? []).reduce((sum, seconds) => sum + seconds, 0);
      if (total > 15) throw new UnifiedGenerationRequestError('Reference videos may be at most 15 seconds in total.');
      return referencePricedQuote(input);
    };
    const { outcome, startVideo } = start({ body: seedanceBody(2), measuredSeconds: 40, quote: cappedQuote });

    await expect(outcome).rejects.toThrow('Reference videos may be at most 15 seconds in total.');
    expect(startVideo).not.toHaveBeenCalled();
  });

  it('measures nothing on an idempotent replay', async () => {
    const { outcome, probeInputDuration, startVideo } = start({
      body: seedanceBody(0),
      measuredSeconds: 10,
      existingGeneration: { id: 'generation-1', prediction_id: 'provider-task-original', status: 'processing', cost: 150 },
    });

    await expect(outcome).resolves.toMatchObject({ predictionId: 'provider-task-original', idempotentReplay: true });
    expect(probeInputDuration).not.toHaveBeenCalled();
    expect(startVideo).not.toHaveBeenCalled();
  });

  it('prices a motion run by its reference performance, not the duration it names', async () => {
    const understated = start({
      body: motionBody(1, 1),
      measuredSeconds: 30,
      operation: MOTION_OPERATION,
      quote: durationPricedQuote,
    });
    const refusal = await understated.outcome.then(() => null, (error: unknown) => error);
    expect(refusal).toMatchObject({
      code: 'REFERENCE_DURATION_CHANGED',
      quotedCostCredits: 10,
      costCredits: 300,
      inputs: [{ index: 1, slot: 'referenceVideo', durationSeconds: 30 }],
    });
    expect(understated.startMotion).not.toHaveBeenCalled();

    const honest = start({
      body: motionBody(30, 30),
      measuredSeconds: 29.9,
      operation: MOTION_OPERATION,
      quote: durationPricedQuote,
    });
    await expect(honest.outcome).resolves.toMatchObject({ success: true });
    expect(honest.startMotion).toHaveBeenCalledWith(expect.objectContaining({ duration: 30, quotedCostCredits: 300 }));
  });

  it('refuses a reference whose length cannot be read, or that is not an HTTPS object', async () => {
    await expect(resolveBillableInputDurations({
      request: parseUnifiedGenerationRequest(seedanceBody(10)),
      descriptor: null,
      operation: SEEDANCE_OPERATION,
      resolveInputSource: async (url) => url,
      probeInputDuration: async () => null,
    })).rejects.toMatchObject({ status: 422, fieldErrors: { 'inputs.0': expect.any(String) } });

    const probe = vi.fn(async () => 10);
    await expect(resolveBillableInputDurations({
      request: parseUnifiedGenerationRequest(seedanceBody(10)),
      descriptor: null,
      operation: SEEDANCE_OPERATION,
      resolveInputSource: async () => 'provider-asset-handle-1',
      probeInputDuration: probe,
    })).rejects.toBeInstanceOf(UnifiedGenerationRequestError);
    expect(probe).not.toHaveBeenCalled();
  });

  it('measures nothing when neither the price nor a limit reads a length', async () => {
    const probe = vi.fn(async () => 10);
    const request = parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'kling-3.0-video',
      catalogRevision: 'catalog-v2',
      settings: { duration: 5 },
      inputs: [{ slot: 'videoElements', kind: 'video', url: REFERENCE_URL, handle: '@move' }],
    });

    const result = await resolveBillableInputDurations({
      request,
      descriptor: null,
      operation: { pricingConfig: { durationSettingKey: 'duration', rate: 20 }, validationConfig: {} },
      resolveInputSource: async (url) => url,
      probeInputDuration: probe,
    });

    expect(result).toEqual({ request, verified: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it('finds every slot whose length is read, at any depth', () => {
    const slots = durationBoundInputSlots(
      {
        inputModes: [{
          key: 'references',
          label: 'References',
          default: true,
          slots: [
            { key: 'audioReferences', kind: 'audio', role: 'reference', label: 'Audio', min: 0, max: 3, durationMetadata: 'optional', maxDurationSeconds: 15 },
            { key: 'imageReferences', kind: 'image', role: 'reference', label: 'Images', min: 0, max: 3 },
          ],
        }],
        inputConstraints: [{ type: 'combined-duration', slotKeys: ['clipReferences'], max: 15, message: 'Too long.' }],
      },
      {
        pricingConfig: {
          branches: [{ pricing: { strategy: 'reference-adjustment', config: { referenceDurationSlots: ['videoReferences'] } } }],
        },
        validationConfig: { rules: [{ type: 'combined-duration', slotKeys: ['motionReferences'], max: 30 }] },
      },
    );

    expect([...slots].sort()).toEqual(['audioReferences', 'clipReferences', 'motionReferences', 'videoReferences']);
  });
});
