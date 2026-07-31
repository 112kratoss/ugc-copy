import { describe, expect, it, vi } from 'vitest';

import { GenerationModelCatalogSchemaUnavailableError } from '@/lib/generation-model-catalog-store';
import {
  UnifiedGenerationRequestError,
  buildUnifiedGenerationQuoteInput,
  buildUnifiedGenerationQuoteInputForCatalog,
  dispatchCatalogGenerationAdapter,
  loadUnifiedGenerationCatalog,
  parseUnifiedGenerationRequest,
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

  it('resolves the remix source with the service-role client', async () => {
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
    const resolveSource = vi.fn(async (_client: unknown, _userId: string, _raw: unknown) => null);

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

    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(resolveSource.mock.calls[0][0]).toBe(adminSupabase);
    expect(resolveSource.mock.calls[0][1]).toBe('user-1');
    expect(resolveSource.mock.calls[0][2]).toBe('3f8f0c70-9a54-4f6e-8f5a-1c2d3e4f5a6b');
  });
});
