import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  catalogRunInputFacts,
  GENERATION_PROMPT_MAX_LENGTH,
  MOTION_PROMPT_MAX_LENGTH,
} from '../../ugc-mobile/lib/model-catalog/protocol';
import { remixSourceTables } from '@/__tests__/fixtures/remix-source-rows';
import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { GenerationModelCatalogSchemaUnavailableError } from '@/lib/generation-model-catalog-store';
import { GenerationServiceError } from '@/lib/generation-services';
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

  it('reads the price the caller was shown, and refuses one that is not a whole number of credits', () => {
    const body = { kind: 'video', modelId: 'seedance-2', catalogRevision: 'release-revision-2', settings: {} };
    expect(parseUnifiedGenerationRequest({ ...body, expectedCostCredits: 80 }).expectedCostCredits).toBe(80);
    expect(parseUnifiedGenerationRequest({ ...body, expectedCostCredits: 0 }).expectedCostCredits).toBe(0);
    // An app from before the field sends nothing, and is priced and charged as before.
    expect(parseUnifiedGenerationRequest(body).expectedCostCredits).toBeNull();
    expect(parseUnifiedGenerationRequest({ ...body, expectedCostCredits: null }).expectedCostCredits).toBeNull();

    for (const malformed of ['80', -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, true, {}]) {
      let refusal: unknown = null;
      try {
        parseUnifiedGenerationRequest({ ...body, expectedCostCredits: malformed });
      } catch (error) {
        refusal = error;
      }
      expect(refusal, String(malformed)).toBeInstanceOf(UnifiedGenerationRequestError);
      expect(refusal, String(malformed)).toMatchObject({
        status: 422,
        fieldErrors: { expectedCostCredits: expect.any(String) },
      });
    }
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

  it('reads from a run body every input fact the app priced it with', () => {
    // The app asks for a run's price with catalogRunQuoteInput of the run it is about to
    // send; this start quotes the run with the same function after parsing its JSON body.
    // Parsing keeps every fact the app counted: inputs sent by asset id alone, a clip of
    // no measured length, a zero-second one. A Wan 2.7 start frame beside five references
    // is a sixth image here, as in the app's quote.
    const appInputs = [
      ...[1, 2, 3, 4, 5].map((index) => ({
        slot: 'imageReferences',
        kind: 'image' as const,
        url: `https://cdn.example.com/look-${index}.png`,
        storagePath: `uploads/user/look-${index}.png`,
        label: `Look ${index}`,
        handle: `@look_${index}`,
        durationSeconds: null,
        sourceGenerationId: null,
      })),
      { slot: 'startFrame', kind: 'image' as const, url: 'https://cdn.example.com/doorstep.png', storagePath: null, label: 'Doorstep', handle: null, durationSeconds: null, sourceGenerationId: null },
      { slot: 'videoReferences', kind: 'video' as const, url: 'https://cdn.example.com/walk.mp4', storagePath: null, label: 'Walk', handle: '@walk', durationSeconds: 0, sourceGenerationId: null },
      { slot: 'videoReferences', kind: 'video' as const, url: 'https://cdn.example.com/turn.mp4', assetId: 'asset-turn', storagePath: null, label: 'Turn', handle: '@turn', durationSeconds: 4.5, sourceGenerationId: null },
      { slot: 'characters', kind: 'character' as const, url: null, assetId: 'character-1', storagePath: null, label: 'Hero', handle: null, durationSeconds: null, sourceGenerationId: null },
      { slot: 'preparedVoices', kind: 'preparedVoice' as const, url: null, assetId: 'voice-1', storagePath: null, label: 'Narrator', handle: null, durationSeconds: null, sourceGenerationId: null },
    ];
    const body = {
      kind: 'video',
      modelId: 'wan-2.7',
      catalogRevision: 'wan-release',
      settings: { referenceMode: 'elements' },
      prompt: 'The product turns on the doorstep.',
      inputs: appInputs,
      sourceGenerationId: null,
    };
    const input = buildUnifiedGenerationQuoteInput(parseUnifiedGenerationRequest(JSON.parse(JSON.stringify(body))));

    expect({ inputCounts: input.inputCounts, inputMetadata: input.inputMetadata }).toEqual(catalogRunInputFacts(appInputs));
    expect(input.inputCounts).toEqual({ images: 6, videos: 2, audios: 0, preparedAudios: 1, characters: 1 });
    expect(input.inputMetadata).toEqual({
      slots: {
        imageReferences: { count: 5 },
        startFrame: { count: 1 },
        videoReferences: { count: 2, durationsSeconds: [0, 4.5] },
        characters: { count: 1 },
        preparedVoices: { count: 1 },
      },
      referenceVideoDurationsSeconds: [0, 4.5],
    });
  });

  it('counts a slot named after a built-in as a slot of that name, and changes no built-in', () => {
    // Slot names come from the request body, and `constructor` or `toString` pass the slot
    // pattern: counted in a plain object, each read the built-in it shadows and wrote onto it
    // (`Object.count`, a `durationsSeconds` list on Object that grew with every start).
    const parsed = parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'remotely-published-model',
      catalogRevision: 'release-revision-2',
      settings: {},
      inputs: [
        { slot: 'constructor', kind: 'video', url: 'https://cdn.example.com/a.mp4', durationSeconds: 2 },
        { slot: 'toString', kind: 'video', url: 'https://cdn.example.com/b.mp4', durationSeconds: 3 },
      ],
    });
    const input = buildUnifiedGenerationQuoteInput(parsed);

    expect(Object.hasOwn(Object, 'count')).toBe(false);
    expect(Object.hasOwn(Object, 'durationsSeconds')).toBe(false);
    expect(Object.hasOwn(Object.prototype.toString, 'count')).toBe(false);
    expect(Object.entries(input.inputMetadata?.slots ?? {})).toEqual([
      ['constructor', { count: 1, durationsSeconds: [2] }],
      ['toString', { count: 1, durationsSeconds: [3] }],
    ]);
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

  // The legacy video start takes clips and tracks as URLs. Handed only those, it
  // had nothing to keep them by, and a remix of the run lost its reference clip.
  it('tells the video start what each reference clip and track is, beside its URL', async () => {
    const startVideo = vi.fn(async () => ({
      predictionId: 'provider-task-seedance',
      generationId: 'generation-seedance',
      remainingCredits: 10,
      cost: 90,
    }));
    const request = parseUnifiedGenerationRequest({
      kind: 'video',
      modelId: 'seedance-2',
      catalogRevision: 'catalog-v2',
      prompt: 'Change the first person in the reference video to @ali.',
      settings: { duration: 12, resolution: '480p', referenceMode: 'elements' },
      inputs: [
        { slot: 'imageReferences', kind: 'image', url: 'https://signed.example.com/ali.png', label: 'Ali', handle: '@ali', storagePath: 'uploads/user-1/ali.png' },
        { slot: 'videoReferences', kind: 'video', url: 'https://signed.example.com/dance.mp4', label: 'Dance clip', storagePath: 'uploads/user-1/dance.mp4', durationSeconds: 9 },
        { slot: 'audioReferences', kind: 'audio', url: 'https://signed.example.com/beat.mp3', label: 'Beat', storagePath: 'uploads/user-1/beat.mp3', sourceGenerationId: 'generation-0' },
      ],
    });

    await dispatchCatalogGenerationAdapter({
      request,
      quote: {
        modelId: 'seedance-2',
        catalogRevision: 'catalog-v2',
        normalizedSettings: { duration: 12, resolution: '480p', referenceMode: 'elements' },
        costCredits: 90,
      },
      operation: {
        modelId: 'seedance-2',
        kind: 'video',
        adapterKey: 'video-v1',
        providerModelMap: {},
        adapterConfig: {},
        pricingStrategy: 'flat',
        pricingConfig: { credits: 90 },
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
      referenceVideoUrls: ['https://signed.example.com/dance.mp4'],
      referenceVideos: [{ kind: 'video', label: 'Dance clip', storagePath: 'uploads/user-1/dance.mp4', sourceGenerationId: null, durationSeconds: 9 }],
      referenceAudioUrls: ['https://signed.example.com/beat.mp3'],
      referenceAudios: [{ kind: 'audio', label: 'Beat', storagePath: 'uploads/user-1/beat.mp3', sourceGenerationId: 'generation-0', durationSeconds: null }],
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
        callerIsGuest: false,
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
        callerIsGuest: false,
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

  // C3: the creators prepare a Seedance asset from an upload and send its id beside the
  // upload's link. Web sent the id as the link, which the length check cannot read, so
  // a prepared clip was refused after its upload; the app's id was dropped here.
  it('measures a prepared clip by its link and hands the video start the asset id', async () => {
    const body = {
      ...seedanceBody(10),
      inputs: [{ slot: 'videoReferences', kind: 'video', url: REFERENCE_URL, assetId: 'asset-clip-1', durationSeconds: 10 }],
    };
    const { outcome, startVideo, probeInputDuration } = start({ body, measuredSeconds: 10 });

    await expect(outcome).resolves.toMatchObject({ success: true });
    expect(probeInputDuration).toHaveBeenCalledWith(REFERENCE_URL);
    expect(startVideo).toHaveBeenCalledWith(expect.objectContaining({
      referenceVideoUrls: [REFERENCE_URL],
      seedanceAssets: {
        images: [],
        videos: [expect.objectContaining({ assetId: 'asset-clip-1', assetType: 'Video', status: 'active', sourceUrl: REFERENCE_URL })],
        audios: [],
      },
    }));
  });

  it('records no prepared assets for a run that prepared none', async () => {
    const { outcome, startVideo } = start({ body: seedanceBody(10), measuredSeconds: 10 });

    await expect(outcome).resolves.toMatchObject({ success: true });
    expect(startVideo).toHaveBeenCalledWith(expect.objectContaining({ seedanceAssets: null }));
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

  // The start quotes the run itself and compared that only with its own second quote, at
  // the measured lengths: a start priced above what the creator was shown was charged
  // whenever its two quotes agreed with each other. The creator's price now comes with the
  // run (`expectedCostCredits`), so a drift between the quote and the start is refused.
  describe('a price the caller was shown', () => {
    function shown(body: Record<string, unknown>, expectedCostCredits: number) {
      return { ...body, expectedCostCredits };
    }

    it('refuses, before anything is held, a start it prices above that price', async () => {
      const run = start({ body: shown(seedanceBody(10), 120), measuredSeconds: 10 });

      const refusal = await run.outcome.then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(GenerationServiceError);
      expect(refusal).toMatchObject({ status: 409, failureCode: 'cost_changed' });
      expect(run.startVideo).not.toHaveBeenCalled();
    });

    it('charges its own price when that is the price shown, or less', async () => {
      for (const price of [150, 200]) {
        const run = start({ body: shown(seedanceBody(10), price), measuredSeconds: 10 });

        await expect(run.outcome).resolves.toMatchObject({ success: true });
        expect(run.startVideo).toHaveBeenCalledWith(expect.objectContaining({ quotedCostCredits: 150 }));
      }
    });

    it('prices and charges a run that comes without one as before', async () => {
      const run = start({ body: seedanceBody(10), measuredSeconds: 10 });

      await expect(run.outcome).resolves.toMatchObject({ success: true });
      expect(run.startVideo).toHaveBeenCalledWith(expect.objectContaining({ quotedCostCredits: 150 }));
    });

    it('sends a reference that runs longer than reported back to be priced at its measured length', async () => {
      const run = start({ body: shown(seedanceBody(10), 150), measuredSeconds: 12 });

      await expect(run.outcome).rejects.toMatchObject({
        code: 'REFERENCE_DURATION_CHANGED',
        quotedCostCredits: 150,
        costCredits: 170,
        inputs: [{ index: 0, slot: 'videoReferences', durationSeconds: 12 }],
      });
      expect(run.startVideo).not.toHaveBeenCalled();
    });

    it('charges a measured length whose price stays within the price shown', async () => {
      // Shown 160; quoted 150 at the reported 10 s and 155 at the measured 10.5 s.
      const run = start({ body: shown(seedanceBody(10), 160), measuredSeconds: 10.5 });

      await expect(run.outcome).resolves.toMatchObject({ success: true });
      expect(run.startVideo).toHaveBeenCalledWith(expect.objectContaining({ quotedCostCredits: 155 }));
    });

    it('replays an accepted attempt whatever the run costs now', async () => {
      const run = start({
        body: shown(seedanceBody(10), 1),
        measuredSeconds: 10,
        existingGeneration: { id: 'generation-1', prediction_id: 'original-task', status: 'processing', cost: 150 },
      });

      await expect(run.outcome).resolves.toMatchObject({ predictionId: 'original-task', idempotentReplay: true });
      expect(run.startVideo).not.toHaveBeenCalled();
    });

    describe('when its quote of the run differs from that price', () => {
      let records: BackendLogRecord[] = [];
      let restoreSink: () => void = () => undefined;

      beforeEach(() => {
        records = [];
        restoreSink = setBackendLogSink((record) => {
          records.push(record);
        });
      });

      afterEach(() => {
        restoreSink();
      });

      it('logs an error for a price above it, with both prices', async () => {
        await start({ body: shown(seedanceBody(10), 120), measuredSeconds: 10 }).outcome.catch(() => undefined);

        expect(records).toEqual([expect.objectContaining({
          level: 'error',
          msg: 'generation_start_quote_drift',
          modelId: 'seedance-2',
          kind: 'video',
          catalogRevision: 'catalog-v2',
          client: 'web',
          expectedCostCredits: 120,
          quotedCostCredits: 150,
          costCredits: 150,
        })]);
      });

      it('logs a warning for a price below it', async () => {
        await start({ body: shown(seedanceBody(10), 200), measuredSeconds: 10 }).outcome;

        expect(records).toEqual([expect.objectContaining({
          level: 'warn',
          msg: 'generation_start_quote_drift',
          expectedCostCredits: 200,
          quotedCostCredits: 150,
        })]);
      });

      it('logs nothing when the two agree, even when the measured length moves the price', async () => {
        await start({ body: shown(seedanceBody(10), 150), measuredSeconds: 10 }).outcome;
        await start({ body: shown(seedanceBody(10), 150), measuredSeconds: 12 }).outcome.catch(() => undefined);
        await start({ body: shown(seedanceBody(14), 190), measuredSeconds: 10 }).outcome;

        expect(records).toEqual([]);
      });
    });
  });
});

// A run from the page with one named reference picture, taken from the request body to
// the provider request. The catalog's quote, the adapter and the video start are the real
// ones, so the mapping in one and the routing in the other are held to each other: the
// adapter hands named pictures over as elements, and four models never sent those.
describe('a page run with a named reference picture', () => {
  const REFERENCE = 'https://signed.example.com/uploads/user-1/lead.png';
  const FIRST_FRAME = 'https://signed.example.com/uploads/user-1/first-frame.png';

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('KIE_AI_API_KEY', 'test-key');
    vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** What a start asks of the service client: the idempotency claim and lock, the reservation, the provider task. */
  function createAdminClient() {
    return {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'claim_generation_start_request') return { data: 'claimed', error: null };
        if (fn === 'start_generation') {
          return {
            data: { status: 'started', generation_id: 'generation-1', remaining_credits: 100, cost: args.p_cost },
            error: null,
          };
        }
        if (fn === 'attach_generation_provider_task') {
          return { data: { status: 'attached', generation_id: 'generation-1' }, error: null };
        }
        return { data: true, error: null };
      }),
      from: vi.fn(() => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return builder;
      }),
    };
  }

  async function startFromPage(
    modelId: string,
    settings: Record<string, unknown>,
    frames: Array<Record<string, unknown>> = [],
  ) {
    const { startUnifiedGenerationForRoute: startRoute } = await import('@/lib/unified-generation-start-service');
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const { loadPublishedGenerationModelCatalog } = await import('@/lib/generation-model-catalog-store');
    const { catalog } = await loadPublishedGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

    const requests: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') requests.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'provider-task-1' } }) } as Response;
    });

    const outcome = await startRoute(
      {
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': `named-reference-${modelId}` },
        }),
        // The body CreateVideoClient posts for one reference card.
        body: {
          kind: 'video',
          modelId,
          catalogRevision: catalog.revision,
          prompt: '@lead walks along the harbour at dusk.',
          shots: [],
          settings: {
            aspectRatio: '16:9',
            sound: false,
            fixedLens: false,
            isMultiShot: false,
            referenceMode: 'elements',
            ...settings,
          },
          inputs: [
            {
              slot: 'imageReferences',
              kind: 'image',
              url: REFERENCE,
              assetId: null,
              label: 'Hero shot',
              handle: '@lead',
              storagePath: 'uploads/user-1/lead.png',
              sourceGenerationId: null,
            },
            ...frames,
          ],
        },
        userId: 'user-1',
        callerIsGuest: false,
        supabase: {} as never,
        adminSupabase: createAdminClient() as never,
      },
      {
        resolveSource: vi.fn(async () => null) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
        // The real video start. Keeping a run's inputs has its own suite.
        startVideo: (params) => startVideoGeneration({ ...params, persistInputMedia: false }),
      },
    );
    return { outcome, request: requests[0] };
  }

  it.each([
    {
      label: 'Grok Imagine Video',
      modelId: 'grok-imagine-video',
      settings: { mode: 'normal', duration: 6, resolution: '480p' },
      request: { model: 'grok-imagine/image-to-video', input: { image_urls: [REFERENCE] } },
    },
    {
      label: 'Grok Imagine Video 1.5',
      modelId: 'grok-imagine-video-1.5',
      settings: { duration: 5, resolution: '480p' },
      request: { model: 'grok-imagine-video-1-5-preview', input: { image_urls: [REFERENCE] } },
    },
    {
      label: 'Wan 2.7',
      modelId: 'wan-2.7',
      settings: { duration: 5, resolution: '1080p' },
      request: { model: 'wan/2-7-r2v', input: { reference_image: [REFERENCE] } },
    },
    {
      label: 'HappyHorse 1.1',
      modelId: 'happyhorse-1.1',
      settings: { duration: 5, resolution: '720p' },
      request: { model: 'happyhorse-1-1/reference-to-video', input: { reference_image: [REFERENCE] } },
    },
    {
      label: 'Veo 3.1 Fast',
      modelId: 'veo-3.1',
      settings: { mode: 'veo3_fast', duration: 8, resolution: '720p' },
      // Kie's jobs API: model veo-3-1, the tier and the fields inside `input`.
      request: { model: 'veo-3-1', input: { model: 'veo3_fast', generation_type: 'REFERENCE_2_VIDEO', image_urls: [REFERENCE] } },
    },
    {
      label: 'Veo 3.1 Lite',
      modelId: 'veo-3.1',
      settings: { mode: 'veo3_lite', duration: 8, resolution: '720p' },
      request: { model: 'veo-3-1', input: { model: 'veo3_lite', generation_type: 'REFERENCE_2_VIDEO', image_urls: [REFERENCE] } },
    },
    {
      // One of the models that always sent it, so a pass here is not the harness.
      label: 'Seedance 2.5',
      modelId: 'seedance-2-5',
      settings: { duration: 5, resolution: '720p' },
      request: { model: 'bytedance/seedance-2-5', input: { reference_image_urls: [REFERENCE] } },
    },
  ])('sends $label the picture', async ({ modelId, settings, request: expected }) => {
    const { outcome, request } = await startFromPage(modelId, settings);

    expect(outcome).toMatchObject({ success: true, predictionId: 'provider-task-1', modelId });
    expect(request).toMatchObject(expected);
  });

  it('sends Wan 2.7 the picture beside a first frame', async () => {
    const { request } = await startFromPage('wan-2.7', { duration: 5, resolution: '1080p' }, [{
      slot: 'startFrame',
      kind: 'image',
      url: FIRST_FRAME,
      label: 'Start frame',
      storagePath: 'uploads/user-1/first-frame.png',
      sourceGenerationId: null,
    }]);

    expect(request).toMatchObject({
      model: 'wan/2-7-r2v',
      input: { reference_image: [REFERENCE], first_frame: FIRST_FRAME },
    });
  });

  it('sends Grok Imagine Video 1.5 the picture beside a first frame', async () => {
    // grok-imagine-video-1-5-preview: first_frame_url "Can be passed together with image_urls"
    // (two paid runs kept both, 2026-10-29).
    const { outcome, request } = await startFromPage('grok-imagine-video-1.5', { duration: 5, resolution: '480p' }, [{
      slot: 'startFrame',
      kind: 'image',
      url: FIRST_FRAME,
      label: 'Start frame',
      storagePath: 'uploads/user-1/first-frame.png',
      sourceGenerationId: null,
    }]);

    expect(outcome).toMatchObject({ success: true, modelId: 'grok-imagine-video-1.5' });
    expect(request).toMatchObject({
      model: 'grok-imagine-video-1-5-preview',
      input: { image_urls: [REFERENCE], first_frame_url: FIRST_FRAME },
    });
    expect((request as { input: Record<string, unknown> }).input).not.toHaveProperty('aspect_ratio');
  });

  it('refuses a page run on Seedance 1.5 Pro, which Kie retired, at its quote, so nothing reaches Kie', async () => {
    // The catalog no longer offers it; the start's own guard before the hold is in
    // generation-services.test.ts ("refuses a model Kie retired before anything is held").
    await expect(startFromPage('seedance-1.5-pro', { duration: 4, resolution: '720p' }))
      .rejects.toThrow('This model is no longer available.');
    expect(fetch).not.toHaveBeenCalled();
  });
});

// 01-1: the legacy image start checks a prompt before it hands it to the catalog
// adapter. This start handed the adapter the raw prompt, so on the default image model
// a mention reached the provider as plain text, with no word of the picture it meant,
// and neither the blank check nor the shared limit ran.
describe('a catalog image run', () => {
  const IMAGE_OPERATION = {
    modelId: 'nano-banana-2',
    kind: 'image' as const,
    adapterKey: 'kie-task-v1' as const,
    providerModelMap: { default: 'nano-banana-2' },
    adapterConfig: {},
    pricingStrategy: 'flat' as const,
    pricingConfig: { credits: 8 },
    validationStrategy: 'descriptor-rules-v1' as const,
    validationConfig: {},
    verificationConfig: {},
  };
  const HERO = 'https://signed.example.com/uploads/user-1/hero.png';
  const BACKDROP = 'https://signed.example.com/uploads/user-1/backdrop.png';

  function dispatchImage(prompt: string, inputs: Array<Record<string, unknown>> = []) {
    const startCatalog = vi.fn(async (params: Record<string, unknown>) => {
      void params;
      return { predictionId: 'provider-task-image', generationId: 'generation-image', remainingCredits: 92, cost: 8 };
    });
    const outcome = dispatchCatalogGenerationAdapter({
      request: parseUnifiedGenerationRequest({
        kind: 'image',
        modelId: 'nano-banana-2',
        catalogRevision: 'catalog-v2',
        prompt,
        settings: { aspectRatio: '1:1' },
        inputs,
      }),
      quote: {
        modelId: 'nano-banana-2',
        catalogRevision: 'catalog-v2',
        normalizedSettings: { aspectRatio: '1:1' },
        costCredits: 8,
      },
      operation: IMAGE_OPERATION,
      supabase: {} as never,
      adminSupabase: {} as never,
      userId: 'user-1',
      clientRequestKeyHash: 'request-hash',
      sourceGenerationId: null,
      dependencies: { startCatalog, startImage: vi.fn(), startVideo: vi.fn(), startMotion: vi.fn() },
    });
    return { outcome, startCatalog };
  }

  it('refuses a blank prompt and one over the shared limit before anything is held', async () => {
    const blank = dispatchImage('   ');
    await expect(blank.outcome).rejects.toMatchObject({
      status: 400,
      message: 'A prompt is required to generate an image.',
    });
    expect(blank.startCatalog).not.toHaveBeenCalled();

    const long = dispatchImage('a'.repeat(GENERATION_PROMPT_MAX_LENGTH + 1));
    await expect(long.outcome).rejects.toMatchObject({
      status: 400,
      message: `Prompts support up to ${GENERATION_PROMPT_MAX_LENGTH} characters.`,
    });
    expect(long.startCatalog).not.toHaveBeenCalled();
  });

  it('refuses a mention that no picture is named for', async () => {
    const { outcome, startCatalog } = dispatchImage('@a holds the bottle.', [
      { slot: 'imageReferences', kind: 'image', url: HERO, label: 'Hero bottle', handle: '@hero' },
    ]);

    await expect(outcome).rejects.toMatchObject({ status: 400, message: 'Unknown element mention: @a' });
    expect(startCatalog).not.toHaveBeenCalled();
  });

  it('tells the provider which attached picture a mention means, and keeps the prompt as written', async () => {
    const { outcome, startCatalog } = dispatchImage('  @hero on a clean tabletop.  ', [
      { slot: 'imageReferences', kind: 'image', url: BACKDROP },
      { slot: 'imageReferences', kind: 'image', url: HERO, label: 'Hero bottle', handle: '@hero' },
    ]);

    await expect(outcome).resolves.toMatchObject({ predictionId: 'provider-task-image' });
    const sent = startCatalog.mock.calls[0][0];
    expect(sent.prompt).toBe('@hero on a clean tabletop.');
    // The pictures reach the provider in this order, so the named one is the second.
    expect(sent.compiledPrompt).toContain('@hero = attached reference image 2 (Hero bottle)');
    expect(sent.compiledPrompt).toMatch(/\nPrompt:\n@hero on a clean tabletop\.$/);
    expect(sent.inputs).toHaveLength(2);
  });

  it('sends a prompt that mentions nothing as written', async () => {
    const { outcome, startCatalog } = dispatchImage('A bottle on a clean tabletop.', [
      { slot: 'imageReferences', kind: 'image', url: HERO, label: 'Hero bottle', handle: '@hero' },
    ]);

    await expect(outcome).resolves.toMatchObject({ predictionId: 'provider-task-image' });
    expect(startCatalog.mock.calls[0][0]).toMatchObject({ prompt: 'A bottle on a clean tabletop.' });
    expect(startCatalog.mock.calls[0][0]).not.toHaveProperty('compiledPrompt');
  });
});

// 02-1 / C2: the app quoted a multi-shot run by the single-shot length its shot editor
// hides, and the start charged that quote: two 5 s shots on Kling 3.0 Standard were 70
// credits in the app and 140 on web.
describe('a multi-shot run', () => {
  const KLING_OPERATION = {
    modelId: 'kling-3.0-video',
    kind: 'video' as const,
    adapterKey: 'video-v1' as const,
    providerModelMap: {},
    adapterConfig: {},
    pricingStrategy: 'per-second' as const,
    pricingConfig: { durationSettingKey: 'duration', rate: 14 },
    validationStrategy: 'descriptor-rules-v1' as const,
    validationConfig: {},
    verificationConfig: {},
  };

  /** The claim, the lock, and the replay lookup of the idempotent start. */
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
            data: table === 'generations' ? existingGeneration : { credits: 60 },
            error: null,
          }),
        };
        return builder;
      }),
    };
  }

  function startShots(
    settings: Record<string, unknown>,
    existingGeneration: Record<string, unknown> | null = null,
  ) {
    const quoteModel = vi.fn((input: GenerationModelQuoteInput) => ({
      modelId: input.modelId,
      catalogRevision: 'catalog-v2',
      normalizedSettings: input.settings ?? {},
      costCredits: Number(input.settings?.duration ?? 0) * 14,
    }));
    const startVideo = vi.fn(async () => ({
      predictionId: 'provider-task-shots',
      generationId: 'generation-shots',
      remainingCredits: 60,
      cost: 140,
    }));
    const outcome = startUnifiedGenerationForRoute(
      {
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': 'multi-shot-key' },
        }),
        body: {
          kind: 'video',
          modelId: 'kling-3.0-video',
          catalogRevision: 'catalog-v2',
          prompt: '',
          settings: { mode: 'std', isMultiShot: true, ...settings },
          shots: [
            { prompt: 'Open on the harbour at dusk.', duration: 5 },
            { prompt: 'Cut to the lighthouse.', duration: 4.6 },
          ],
        },
        userId: 'user-1',
        callerIsGuest: false,
        supabase: {} as never,
        adminSupabase: createAdminClient(existingGeneration) as never,
      },
      {
        loadCatalog: vi.fn(async () => ({
          catalog: {
            schemaVersion: 2,
            revision: 'catalog-v2',
            defaults: { image: null, video: 'kling-3.0-video', motion: null },
            models: [],
          },
          operations: new Map([[KLING_OPERATION.modelId, KLING_OPERATION]]),
          source: 'database' as const,
          releaseId: 'release-v2',
          releaseSchemaVersion: 2,
        })) as never,
        quoteModel: quoteModel as never,
        resolveSource: vi.fn(async () => null) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
        startVideo: startVideo as never,
      },
    );
    return { outcome, quoteModel, startVideo };
  }

  it('is quoted and started at its shots’ total length', async () => {
    const { outcome, quoteModel, startVideo } = startShots({});

    await expect(outcome).resolves.toMatchObject({ success: true, predictionId: 'provider-task-shots' });
    // 5 s and 4.6 s: 10 s together, each shot counted in whole seconds.
    expect(quoteModel).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ duration: 10 }) }),
      expect.anything(),
    );
    expect(startVideo).toHaveBeenCalledWith(expect.objectContaining({
      isMultiShot: true,
      duration: 10,
      quotedCostCredits: 140,
    }));
  });

  it('accepts a body that names the total', async () => {
    const { outcome, startVideo } = startShots({ duration: 10 });

    await expect(outcome).resolves.toMatchObject({ success: true });
    expect(startVideo).toHaveBeenCalledWith(expect.objectContaining({ quotedCostCredits: 140 }));
  });

  it('refuses a body that names another length, before it is priced', async () => {
    const { outcome, quoteModel, startVideo } = startShots({ duration: 5 });

    const refusal = await outcome.then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnifiedGenerationRequestError);
    expect(refusal).toMatchObject({
      status: 422,
      fieldErrors: { 'settings.duration': "The run's length must equal its shots' total. Update the app, then generate again." },
    });
    expect(quoteModel).not.toHaveBeenCalled();
    expect(startVideo).not.toHaveBeenCalled();
  });

  it('still replays an attempt that was accepted before the rule', async () => {
    const { outcome, startVideo } = startShots(
      { duration: 5 },
      { id: 'generation-shots', prediction_id: 'provider-task-original', status: 'processing', cost: 70 },
    );

    await expect(outcome).resolves.toMatchObject({ predictionId: 'provider-task-original', idempotentReplay: true });
    expect(startVideo).not.toHaveBeenCalled();
  });
});

// The two fixes above, from the request body to the provider request, with the
// catalog's quote and the real start services.
describe('a page run the provider is sent', () => {
  const CLIP = 'https://signed.example.com/uploads/user-1/dance.mp4';
  const HERO = 'https://signed.example.com/uploads/user-1/hero.png';
  /** The database calls of the last start, readable after one that was refused. */
  let lastRpc: { mock: { calls: unknown[][] } } | null = null;
  const lastRpcNames = () => (lastRpc?.mock.calls ?? []).map(([fn]) => String(fn));

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('KIE_AI_API_KEY', 'test-key');
    vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function startFromPage(body: Record<string, unknown>, { measuredSeconds = 4 }: { measuredSeconds?: number } = {}) {
    const { startUnifiedGenerationForRoute: startRoute } = await import('@/lib/unified-generation-start-service');
    const { startCatalogGeneration, startVideoGeneration } = await import('@/lib/generation-services');
    const { loadPublishedGenerationModelCatalog } = await import('@/lib/generation-model-catalog-store');
    const { catalog } = await loadPublishedGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

    const requests: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') requests.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'provider-task-1' } }) } as Response;
    });
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'claim_generation_start_request') return { data: 'claimed', error: null };
      if (fn === 'start_generation') {
        return {
          data: { status: 'started', generation_id: 'generation-1', remaining_credits: 100, cost: args.p_cost },
          error: null,
        };
      }
      if (fn === 'attach_generation_provider_task') {
        return { data: { status: 'attached', generation_id: 'generation-1' }, error: null };
      }
      return { data: true, error: null };
    });
    lastRpc = rpc;
    const probeInputDuration = vi.fn(async () => measuredSeconds);

    const outcome = await startRoute(
      {
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': `page-run-${String(body.modelId)}` },
        }),
        body: { ...body, catalogRevision: catalog.revision },
        userId: 'user-1',
        callerIsGuest: false,
        supabase: {} as never,
        adminSupabase: {
          rpc,
          from: vi.fn(() => {
            const builder = {
              select: () => builder,
              eq: () => builder,
              maybeSingle: async () => ({ data: null, error: null }),
            };
            return builder;
          }),
        } as never,
      },
      {
        resolveSource: vi.fn(async () => null) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
        resolveInputSource: vi.fn(async (_client: unknown, url: string) => url),
        probeInputDuration,
        // The real starts. Keeping a run's inputs has its own suite.
        startCatalog: (params) => startCatalogGeneration({ ...params, persistInputMedia: false }),
        startVideo: (params) => startVideoGeneration({ ...params, persistInputMedia: false }),
      },
    );
    const reservation = rpc.mock.calls.find(([fn]) => fn === 'start_generation')?.[1];
    return { outcome, request: requests[0], reservation, probeInputDuration };
  }

  /** Refused with `message`, before the start's hold or any provider request. */
  async function expectRefusedFromPage(
    body: Record<string, unknown>,
    message: string,
    options: { measuredSeconds?: number } = {},
  ) {
    lastRpc = null;
    const refusal = await startFromPage(body, options).then(() => null, (error: unknown) => error);
    expect(refusal).toMatchObject({ status: 400, message });
    // The start's own claim on its request key is made; the credit hold is not.
    expect(lastRpcNames()).toContain('claim_generation_start_request');
    expect(lastRpcNames()).not.toContain('start_generation');
    expect(fetch).not.toHaveBeenCalled();
  }

  // The 2026-10-20 model check-up: these runs were held, sent, refused by Kie and refunded.
  describe('what Kie refuses', () => {
    it('refuses a Z-Image prompt past Kie’s 1,000 characters, and starts one at it', async () => {
      const zImage = (prompt: string) => ({
        kind: 'image',
        modelId: 'z-image',
        prompt,
        settings: { aspectRatio: '1:1' },
        inputs: [],
      });
      await expectRefusedFromPage(zImage('a'.repeat(1001)), 'Z-Image prompts support up to 1,000 characters.');

      const { outcome, request } = await startFromPage(zImage('a'.repeat(1000)));
      expect(outcome).toMatchObject({ success: true, modelId: 'z-image' });
      expect((request as { input?: { prompt?: string } } | undefined)?.input?.prompt).toBe('a'.repeat(1000));
    });

    it('refuses a Kling 3 Turbo prompt past 2,500 characters', async () => {
      await expectRefusedFromPage({
        kind: 'video',
        modelId: 'kling-3.0-turbo',
        prompt: 'a'.repeat(2501),
        shots: [],
        settings: { aspectRatio: '16:9', duration: 5, resolution: '720p' },
        inputs: [],
      }, 'Kling 3 Turbo prompts support up to 2,500 characters.');
    });

    it('sends Kling O3 the first shot’s prompt for a multi-shot run the page sends without one', async () => {
      const { outcome, request } = await startFromPage({
        kind: 'video',
        modelId: 'kling-o3',
        prompt: '',
        shots: [
          { prompt: 'Open on the harbour at dusk.', duration: 3 },
          { prompt: 'Cut to the lighthouse.', duration: 2 },
        ],
        settings: { aspectRatio: '16:9', sound: false, duration: 5, resolution: '720p', isMultiShot: true },
        inputs: [],
      });

      expect(outcome).toMatchObject({ success: true, modelId: 'kling-o3' });
      expect(request).toMatchObject({
        model: 'kling-3.0-omni/text-to-video',
        input: {
          prompt: 'Open on the harbour at dusk.',
          customize_multi_shots: true,
          multi_prompt: [
            { prompt: 'Open on the harbour at dusk.', duration: 3 },
            { prompt: 'Cut to the lighthouse.', duration: 2 },
          ],
        },
      });
    });

    it('refuses a motion clip that measures under 3 seconds', async () => {
      const STORAGE = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1';
      await expectRefusedFromPage({
        kind: 'motion',
        modelId: 'kling-2.6',
        prompt: '',
        shots: [],
        settings: { resolution: '720p', characterOrientation: 'video', duration: 3 },
        inputs: [
          { slot: 'characterImage', kind: 'image', url: `${STORAGE}/character.png?token=t` },
          { slot: 'referenceVideo', kind: 'video', url: `${STORAGE}/reference.mp4?token=t`, durationSeconds: 3 },
        ],
      }, 'Kling 2.6 reference video must be at least 3 seconds long. The reference video runs 2.4 seconds.', { measuredSeconds: 2.4 });
    });

    it('refuses a Seedance 2 reference clip that measures under 2 seconds', async () => {
      await expectRefusedFromPage({
        kind: 'video',
        modelId: 'seedance-2',
        prompt: 'Follow the dance in the clip.',
        shots: [],
        settings: { aspectRatio: '16:9', sound: false, duration: 5, resolution: '720p', referenceMode: 'elements' },
        inputs: [{ slot: 'videoReferences', kind: 'video', url: CLIP, label: 'Dance clip', durationSeconds: 2 }],
      }, 'Seedance 2 reference videos must be at least 2 seconds long. Dance clip runs 1.5 seconds.', { measuredSeconds: 1.5 });
    });

    it('refuses a Kling 3.0 video element that measures under 3 seconds, and starts one at 3', async () => {
      const element = {
        kind: 'video',
        modelId: 'kling-3.0-video',
        prompt: 'Replace the background motion with @dancer.',
        shots: [],
        settings: { aspectRatio: '16:9', sound: false, duration: 5, mode: 'std' },
        inputs: [{ slot: 'videoElements', kind: 'video', url: CLIP, label: 'Dancer', handle: '@dancer' }],
      };
      await expectRefusedFromPage(
        element,
        'Kling 3.0 Cinematic video elements must be at least 3 seconds long. Dancer runs 2.4 seconds.',
        { measuredSeconds: 2.4 },
      );

      const { outcome, request } = await startFromPage(element, { measuredSeconds: 3 });
      expect(outcome).toMatchObject({ success: true, modelId: 'kling-3.0-video' });
      expect(request).toMatchObject({
        model: 'kling-3.0/video',
        input: { kling_elements: [{ name: 'dancer', element_input_urls: [CLIP] }] },
      });
    });
  });

  // Installed app builds send a clip carried onto Kling 3.0 from a model whose clips take
  // no handle as `handle: null`. Kling reads no plain clip link, so the start used to hold
  // the run's credits and send it without the clip.
  describe('a Kling 3.0 clip that arrives without a handle', () => {
    const SECOND_CLIP = 'https://signed.example.com/uploads/user-1/turn.mp4';
    const klingClips = (prompt: string, inputs: Array<Record<string, unknown>>) => ({
      kind: 'video',
      modelId: 'kling-3.0-video',
      prompt,
      shots: [],
      settings: { aspectRatio: '16:9', sound: false, duration: 5, mode: 'std' },
      inputs: inputs.map((input) => ({ slot: 'videoElements', kind: 'video', ...input })),
    });

    it('is sent to Kie under a handle made from its name', async () => {
      const { outcome, request, reservation } = await startFromPage(klingClips(
        'A dancer on a rooftop at dusk.',
        [{ url: CLIP, label: 'Reference video', handle: null }],
      ));

      expect(outcome).toMatchObject({ success: true, modelId: 'kling-3.0-video' });
      expect(reservation).toBeDefined();
      expect(request).toMatchObject({
        model: 'kling-3.0/video',
        input: { kling_elements: [{ name: 'reference_video', element_input_urls: [CLIP] }] },
      });
    });

    it('leaves every handle a clip keeps to that clip, wherever it comes in the list', async () => {
      const { outcome, request } = await startFromPage(klingClips(
        'Follow the turn in @reference_video.',
        [
          { url: CLIP, label: 'Reference video', handle: null },
          { url: SECOND_CLIP, label: 'Reference video', handle: '@reference_video' },
        ],
      ));

      expect(outcome).toMatchObject({ success: true, modelId: 'kling-3.0-video' });
      expect(request).toMatchObject({
        input: {
          kling_elements: [
            { name: 'reference_video_2', element_input_urls: [CLIP] },
            { name: 'reference_video', element_input_urls: [SECOND_CLIP] },
          ],
        },
      });
    });

    // A remix of a run kept before clip handles: its words still name the handles the
    // source's clips had, and its clips come back with none. A made handle that took one
    // of those names would bind the mention to whichever clip came first.
    it('never takes a handle the prompt mentions, so a mention nothing holds is refused before the hold', async () => {
      await expectRefusedFromPage(
        klingClips('Keep the camera on @reference_video_2.', [
          { url: CLIP, label: 'Reference video', handle: null },
          { url: SECOND_CLIP, label: 'Reference video', handle: null },
        ]),
        'Unknown element mention: @reference_video_2',
      );
    });

    it('never takes a handle a shot mentions', async () => {
      await expectRefusedFromPage(
        {
          ...klingClips('', [
            { url: CLIP, label: 'Reference video', handle: null },
            { url: SECOND_CLIP, label: 'Reference video', handle: null },
          ]),
          shots: [
            { prompt: 'Open on the rooftop.', duration: 3 },
            { prompt: 'Cut to @reference_video_2 turning.', duration: 2 },
          ],
          settings: { aspectRatio: '16:9', sound: false, duration: 5, mode: 'std', isMultiShot: true },
        },
        'Unknown element mention: @reference_video_2',
      );
    });

    it('is held to Kling’s 3 second element minimum like a named clip', async () => {
      await expectRefusedFromPage(
        klingClips('A dancer on a rooftop at dusk.', [{ url: CLIP, label: 'Dancer', handle: null }]),
        'Kling 3.0 Cinematic video elements must be at least 3 seconds long. Dancer runs 2.4 seconds.',
        { measuredSeconds: 2.4 },
      );
    });
  });

  it('sends Seedance 2 a prepared clip by its asset id, measured by its link', async () => {
    const { outcome, request, reservation, probeInputDuration } = await startFromPage({
      kind: 'video',
      modelId: 'seedance-2',
      prompt: 'Follow the dance in the clip.',
      shots: [],
      settings: { aspectRatio: '16:9', sound: false, duration: 5, resolution: '720p', referenceMode: 'elements' },
      inputs: [{
        slot: 'videoReferences',
        kind: 'video',
        url: CLIP,
        assetId: 'asset-clip-1',
        label: 'Dance clip',
        storagePath: 'uploads/user-1/dance.mp4',
        durationSeconds: 4,
      }],
    });

    expect(outcome).toMatchObject({ success: true, predictionId: 'provider-task-1', modelId: 'seedance-2' });
    expect(probeInputDuration).toHaveBeenCalledWith(CLIP);
    expect(request).toMatchObject({
      model: 'bytedance/seedance-2',
      input: { reference_video_urls: ['asset-clip-1'] },
    });
    // What a remix restores the prepared asset from.
    expect(reservation?.p_workflow_settings).toMatchObject({
      referenceVideoUrls: [CLIP],
      seedanceAssets: { videos: [expect.objectContaining({ assetId: 'asset-clip-1', sourceUrl: CLIP })] },
    });
  });

  it('sends Nano Banana 2 the legend for a mentioned picture and keeps the prompt as written', async () => {
    const { outcome, request, reservation } = await startFromPage({
      kind: 'image',
      modelId: 'nano-banana-2',
      prompt: '@hero on a clean tabletop.',
      settings: { aspectRatio: '1:1', resolution: '1K' },
      inputs: [{
        slot: 'imageReferences',
        kind: 'image',
        url: HERO,
        label: 'Hero bottle',
        handle: '@hero',
        storagePath: 'uploads/user-1/hero.png',
      }],
    });

    expect(outcome).toMatchObject({ success: true, predictionId: 'provider-task-1', modelId: 'nano-banana-2' });
    const sent = request as { input?: { prompt?: string; image_input?: string[] } } | undefined;
    expect(sent?.input?.prompt).toContain('@hero = attached reference image 1 (Hero bottle)');
    expect(sent?.input?.image_input).toEqual([HERO]);
    expect(reservation?.p_prompt).toBe('@hero on a clean tabletop.');
    expect(reservation?.p_workflow_settings).toMatchObject({ compiledPrompt: sent?.input?.prompt });
  });

  // Product decision 20: a motion run on this route is held to Kie's own 2,500 characters.
  describe('a motion run’s prompt', () => {
    const STORAGE = 'https://project.supabase.co/storage/v1/object/sign/uploads/user-1';
    const motionRun = (prompt: string) => startFromPage({
      kind: 'motion',
      modelId: 'kling-2.6',
      prompt,
      shots: [],
      settings: { resolution: '720p', characterOrientation: 'video', duration: 4 },
      inputs: [
        { slot: 'characterImage', kind: 'image', url: `${STORAGE}/character.png?token=t` },
        { slot: 'referenceVideo', kind: 'video', url: `${STORAGE}/reference.mp4?token=t`, durationSeconds: 4 },
      ],
    });

    it('is refused past 2,500 characters, before anything is held', async () => {
      await expect(motionRun('a'.repeat(MOTION_PROMPT_MAX_LENGTH + 1))).rejects.toMatchObject({
        status: 400,
        message: `Prompts support up to ${MOTION_PROMPT_MAX_LENGTH} characters.`,
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('starts at 2,500 characters', async () => {
      const atLimit = 'a'.repeat(MOTION_PROMPT_MAX_LENGTH);
      const { outcome, request, reservation } = await motionRun(atLimit);

      expect(outcome).toMatchObject({ success: true, predictionId: 'provider-task-1', modelId: 'kling-2.6' });
      expect((request as { input?: { prompt?: string } } | undefined)?.input?.prompt).toBe(atLimit);
      expect(reservation?.p_prompt).toBe(atLimit);
    });
  });
});

// The source a start keeps credits the post with a remix and tells its creator,
// so this start asks Remix's own question (`source-generation.ts`). Every other
// start in this file stubs `resolveSource`: a start that stopped asking would
// pass them all.
describe('a run started from someone else’s post', () => {
  const SOURCE = {
    id: '3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b',
    user_id: 'creator-1',
    is_public: true,
    template_run_id: null,
    template_run_step_id: null,
    // What the start's own replay lookup selects.
    prediction_id: 'creator-task',
    status: 'succeeded',
    cost: 10,
  };
  let records: BackendLogRecord[] = [];
  let restoreSink: () => void = () => undefined;

  beforeEach(() => {
    records = [];
    restoreSink = setBackendLogSink((record) => {
      records.push(record);
    });
  });

  afterEach(() => {
    restoreSink();
  });

  async function startFromSource({
    blocks = [],
    callerId = 'user-1',
    callerIsGuest = false,
  }: {
    blocks?: Array<{ blocker_user_id: string; blocked_user_id: string }>;
    callerId?: string;
    callerIsGuest?: boolean;
  } = {}) {
    // The service client: the source, the tables Remix reads, and the start's claim and lock.
    const stored = createStoredRows({ generations: [SOURCE], ...remixSourceTables(SOURCE, { blocks }) }, {
      claim_generation_start_request: () => 'claimed',
      try_acquire_backend_job_lock: () => true,
      release_backend_job_lock: () => true,
    });
    const startCatalog = vi.fn(async () => ({
      predictionId: 'provider-task',
      generationId: 'generation-1',
      remainingCredits: 50,
      cost: 10,
    }));
    const outcome = await startUnifiedGenerationForRoute(
      {
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': 'remix-start-1' },
        }),
        body: {
          kind: 'video',
          modelId: 'catalog-only-video',
          catalogRevision: 'catalog-v2',
          prompt: 'A lighthouse in a storm',
          settings: { duration: 5 },
          sourceGenerationId: SOURCE.id,
        },
        userId: callerId,
        callerIsGuest,
        supabase: { label: 'user-client' } as never,
        adminSupabase: stored.client as never,
      },
      {
        loadCatalog: vi.fn(async () => ({
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
        })) as never,
        quoteModel: vi.fn(() => ({
          modelId: 'catalog-only-video',
          catalogRevision: 'catalog-v2',
          normalizedSettings: { duration: 5 },
          costCredits: 10,
        })) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
        startCatalog: startCatalog as never,
      },
    );
    return { outcome, startCatalog };
  }

  it('starts it as a remix of that post when Remix would hand the caller its recipe', async () => {
    const { outcome, startCatalog } = await startFromSource();

    expect(outcome).toMatchObject({ success: true, predictionId: 'provider-task' });
    expect(startCatalog).toHaveBeenCalledWith(expect.objectContaining({ sourceGenerationId: SOURCE.id }));
  });

  it('starts a run from a creator who blocked the caller as an ordinary one', async () => {
    const { outcome, startCatalog } = await startFromSource({
      blocks: [{ blocker_user_id: SOURCE.user_id, blocked_user_id: 'user-1' }],
    });

    expect(outcome).toMatchObject({ success: true, predictionId: 'provider-task' });
    expect(startCatalog).toHaveBeenCalledWith(expect.objectContaining({ sourceGenerationId: null }));
    // Refused by the rule: a read that failed on the way would have been logged.
    expect(records.filter((record) => record.level === 'error')).toEqual([]);
  });

  // Remix serves a guest nothing but its own creations.
  it('starts a guest’s run from someone else’s post as an ordinary one', async () => {
    const { outcome, startCatalog } = await startFromSource({ callerId: 'guest-1', callerIsGuest: true });

    expect(outcome).toMatchObject({ success: true, predictionId: 'provider-task' });
    expect(startCatalog).toHaveBeenCalledWith(expect.objectContaining({ sourceGenerationId: null }));
    expect(records.filter((record) => record.level === 'error')).toEqual([]);
  });
});
