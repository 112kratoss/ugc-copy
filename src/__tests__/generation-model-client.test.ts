import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import contractFixture from '../../contracts/generation-model-catalog-v1.json';
import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import type { CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import { parseUnifiedGenerationRequest } from '@/lib/unified-generation-start-service';
import {
  applyGenerationModelCatalogToRegistries,
  clearPendingWebStart,
  isAmbiguousWebStartFailure,
  loadPendingWebStart,
  parseClientGenerationModelCatalog,
  reconcileWebCatalogGenerationDraft,
  requestWebGenerationStart,
  requestWebGenerationQuote,
  resolveCatalogModelId,
  resolveWebGenerationQuoteUi,
  savePendingWebStart,
  useWebGenerationModelQuote,
  WebCatalogRequestError,
  webCatalogStartRequest,
  type PendingWebStart,
} from '@/lib/generation-model-client';

describe('web generation model catalog client', () => {
  it('parses the shared schema-v1 fixture', () => {
    const catalog = parseClientGenerationModelCatalog(contractFixture);
    expect(catalog.models[0]).toMatchObject({ id: 'fixture-image', kind: 'image' });
  });

  it('reconstructs legacy inputs from the compact schema-v3 input modes', () => {
    const model = contractFixture.models[0];
    const compactModel = Object.fromEntries(
      Object.entries(model).filter(([key]) => key !== 'inputs'),
    );
    const catalog = parseClientGenerationModelCatalog({
      ...contractFixture,
      schemaVersion: 3,
      models: [{
        ...compactModel,
        availability: { web: true, mobile: true },
        inputModes: [{
          key: 'references',
          label: 'References',
          default: true,
          slots: [{
            key: 'imageReferences',
            kind: 'image',
            role: 'reference',
            label: 'Reference images',
            min: 0,
            max: 2,
            supportsNaming: true,
          }],
        }],
        inputConstraints: [],
      }],
    });

    expect(catalog.models[0].inputs).toEqual({
      imageReferences: { max: 2, supportsNaming: true },
      videoReferences: null,
      audioReferences: null,
      preparedAudioReferences: null,
      characterReferences: null,
      startFrame: false,
      endFrame: false,
      combineFramesWithReferences: false,
    });
  });

  it('rejects malformed web catalog controls and defaults', () => {
    expect(() => parseClientGenerationModelCatalog({
      ...contractFixture,
      defaults: { ...contractFixture.defaults, image: 'missing-image' },
    })).toThrow('Invalid generation model catalog');

    expect(() => parseClientGenerationModelCatalog({
      ...contractFixture,
      models: [{
        ...contractFixture.models[0],
        controls: [{
          key: 'aspectRatio',
          label: 'Aspect ratio',
          type: 'choice',
          presentation: 'chips',
          defaultValue: '1:1',
          options: [],
        }],
      }],
    })).toThrow('Invalid generation model catalog');
  });

  it('adapts a remote-only model into the legacy web registry shape', () => {
    const catalog = parseClientGenerationModelCatalog(contractFixture);
    const registries = { image: { 'retired-image': { id: 'retired-image' } }, video: {}, motion: {} };

    applyGenerationModelCatalogToRegistries(catalog, registries);

    expect(registries.image).toHaveProperty('fixture-image');
    expect((registries.image as Record<string, Record<string, unknown>>)['fixture-image']).toMatchObject({
      id: 'fixture-image',
      displayName: 'Fixture Image',
      aspectRatios: ['1:1', '9:16'],
      maxImages: 2,
      supportsGoogleSearch: true,
      catalogManaged: true,
      catalogActive: true,
    });
    expect(registries.image['retired-image']).toMatchObject({ catalogActive: false });
    expect(resolveCatalogModelId(catalog, 'image', 'retired-image')).toBeNull();
  });

  it('prefers the server default when resolving a fresh active selection', () => {
    const catalog = parseClientGenerationModelCatalog({
      ...contractFixture,
      models: [
        ...contractFixture.models,
        { ...contractFixture.models[0], id: 'bundled-active-image', displayName: 'Bundled Active Image' },
      ],
    });

    expect(resolveCatalogModelId(catalog, 'image', 'bundled-active-image', { preferDefault: true })).toBe('fixture-image');
  });

  it('requires explicit replacement of a retired model instead of silently changing the draft', () => {
    const catalog = parseClientGenerationModelCatalog(contractFixture);
    const draft = reconcileWebCatalogGenerationDraft(catalog, {
      kind: 'image',
      modelId: 'retired-image',
      catalogRevision: 'old-revision',
      settings: {
        aspectRatio: '9:16',
        resolution: 'unsupported',
        removedControl: true,
      },
      prompt: 'Keep this prompt',
      inputs: [
        { slot: 'imageReferences', kind: 'image', url: 'uploads/user/reference.png' },
        { slot: 'removedSlot', kind: 'video', url: 'uploads/user/reference.mp4' },
      ],
    });

    expect(draft).toBeNull();
  });

  it('starts generation through the unified catalog-backed endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      predictionId: 'task-1',
      generationId: 'generation-1',
      status: 'processing',
      remainingCredits: 100,
      cost: 42,
      catalogRevision: '0123456789abcdef',
      modelId: 'remote-video',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestWebGenerationStart({
      kind: 'video',
      modelId: 'remote-video',
      catalogRevision: '0123456789abcdef',
      settings: { duration: 5 },
      prompt: 'A remote model',
      inputs: [],
    }, {
      accessToken: 'token-1',
      idempotencyKey: 'request-1',
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toMatchObject({
      modelId: 'remote-video',
      cost: 42,
    });

    expect(fetcher).toHaveBeenCalledWith('/api/generations', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer token-1',
        'Idempotency-Key': 'request-1',
      }),
    }));
  });

  it('requests an authoritative quote with the current catalog revision', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      modelId: 'fixture-image',
      catalogRevision: '0123456789abcdef',
      normalizedSettings: { aspectRatio: '1:1' },
      costCredits: 7,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestWebGenerationQuote({
      kind: 'image',
      modelId: 'fixture-image',
      settings: { aspectRatio: '1:1' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
      catalogRevision: '0123456789abcdef',
    }, 'token-1', undefined, fetcher as unknown as typeof fetch)).resolves.toMatchObject({ costCredits: 7 });

    expect(fetcher).toHaveBeenCalledWith('/api/generation-models/quote', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
    }));
  });

  it('surfaces the first quote field error as an actionable message', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'The quote request could not be processed.',
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { images: 'Hailuo 2.3 requires a start image.' },
    }), { status: 422, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestWebGenerationQuote({
      kind: 'video',
      modelId: 'hailuo-2.3',
      settings: { referenceMode: 'frames' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
    }, null, undefined, fetcher as unknown as typeof fetch)).rejects.toMatchObject({
      message: 'Hailuo 2.3 requires a start image.',
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { images: 'Hailuo 2.3 requires a start image.' },
    });
  });

  it('does not expose a fallback cost when the catalog is unavailable', () => {
    expect(resolveWebGenerationQuoteUi({
      hasCatalog: false,
      quoteStatus: 'idle',
      quotedCost: null,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: null,
      costLabel: 'Unavailable',
      blocksGenerate: true,
      message: 'Model settings are unavailable. Retry before generating.',
    });
  });

  it('requires an authoritative server quote before showing a cost', () => {
    expect(resolveWebGenerationQuoteUi({
      hasCatalog: true,
      quoteStatus: 'pending',
      quotedCost: null,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: null,
      costLabel: 'Calculating...',
      blocksGenerate: true,
      message: 'Wait for the current generation cost before continuing.',
    });

    expect(resolveWebGenerationQuoteUi({
      hasCatalog: true,
      quoteStatus: 'ready',
      quotedCost: 42,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: 42,
      costLabel: '42 credits',
      blocksGenerate: false,
      message: null,
    });

    expect(resolveWebGenerationQuoteUi({
      hasCatalog: true,
      quoteStatus: 'ready',
      quotedCost: 1,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: 1,
      costLabel: '1 credit',
      blocksGenerate: false,
      message: null,
    });
  });
});

const START_INPUT = {
  kind: 'video' as const,
  modelId: 'remote-video',
  catalogRevision: '0123456789abcdef',
  settings: { duration: 5 },
  prompt: 'A remote model',
  inputs: [],
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function startFailure(response: Response): Promise<unknown> {
  const fetcher = vi.fn(async () => response);
  return requestWebGenerationStart(START_INPUT, {
    accessToken: 'token-1',
    idempotencyKey: 'request-1',
    fetcher: fetcher as unknown as typeof fetch,
  }).then(
    () => { throw new Error('expected the start to fail'); },
    (error: unknown) => error,
  );
}

describe('web generation start answers', () => {
  it('turns a gateway page into a status error that may have started the run', async () => {
    const error = await startFailure(new Response('<html>Gateway Timeout</html>', { status: 504 }));

    expect(error).toBeInstanceOf(WebCatalogRequestError);
    expect(error).toMatchObject({ status: 504, code: undefined, message: 'Could not start generation.' });
    expect(isAmbiguousWebStartFailure(error)).toBe(true);
  });

  it('reads a 200 it cannot parse as a run that started, not as a refusal', async () => {
    const error = await startFailure(new Response('not json', { status: 200 }));

    expect(error).toMatchObject({ status: 502, message: 'The generation service returned an invalid response.' });
    expect(isAmbiguousWebStartFailure(error)).toBe(true);
  });

  it('keeps the measured lengths of a REFERENCE_DURATION_CHANGED refusal', async () => {
    const error = await startFailure(jsonResponse({
      code: 'REFERENCE_DURATION_CHANGED',
      error: 'Check the updated cost, then generate again.',
      costCredits: 96,
      quotedCostCredits: 80,
      inputs: [{ index: 0, durationSeconds: 7.3 }],
    }, 409));

    expect(error).toMatchObject({
      status: 409,
      code: 'REFERENCE_DURATION_CHANGED',
      details: { costCredits: 96, quotedCostCredits: 80, inputs: [{ index: 0, durationSeconds: 7.3 }] },
    });
    expect(isAmbiguousWebStartFailure(error)).toBe(false);
  });

  it('keeps the held generation of a submission that is still pending', async () => {
    const error = await startFailure(jsonResponse({
      code: 'submission_pending',
      error: 'Your credits stay reserved while we confirm it.',
      generationId: 'generation-held',
    }, 409));

    expect(error).toMatchObject({ code: 'submission_pending', details: { generationId: 'generation-held' } });
    expect(isAmbiguousWebStartFailure(error)).toBe(true);
  });
});

describe('isAmbiguousWebStartFailure', () => {
  const refusal = (status: number, code?: string) => new WebCatalogRequestError('refused', status, code);

  it('counts no answer at all as a start that may be running', () => {
    expect(isAmbiguousWebStartFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isAmbiguousWebStartFailure(new SyntaxError('Unexpected token <'))).toBe(true);
    expect(isAmbiguousWebStartFailure(new DOMException('The operation was aborted.', 'AbortError'))).toBe(true);
    expect(isAmbiguousWebStartFailure(refusal(0))).toBe(true);
  });

  it('counts an answer saying the start is under way as ambiguous', () => {
    expect(isAmbiguousWebStartFailure(refusal(409, 'GENERATION_START_IN_PROGRESS'))).toBe(true);
    expect(isAmbiguousWebStartFailure(refusal(409, 'submission_pending'))).toBe(true);
    expect(isAmbiguousWebStartFailure(refusal(503, 'GENERATION_ADAPTER_UNAVAILABLE'))).toBe(true);
    // The start RPC's own in-progress answer carries no code.
    expect(isAmbiguousWebStartFailure(refusal(409))).toBe(true);
  });

  it('counts a server fault without a refusal code as ambiguous', () => {
    expect(isAmbiguousWebStartFailure(refusal(500))).toBe(true);
    expect(isAmbiguousWebStartFailure(refusal(500, 'GENERATION_START_FAILED'))).toBe(true);
    expect(isAmbiguousWebStartFailure(refusal(502))).toBe(true);
  });

  it('counts a refusal made before any credits were held as definitive, whatever its status', () => {
    for (const [status, code] of [
      [402, 'insufficient_credits'],
      [422, 'prompt_blocked'],
      [422, 'provider_rejected'],
      [400, 'invalid_input_media'],
      [429, 'provider_busy'],
      [429, 'RATE_LIMITED'],
      [503, 'service_misconfigured'],
      [503, 'provider_unavailable'],
      [503, 'GENERATION_SERVICE_UNAVAILABLE'],
      [422, 'INVALID_GENERATION_REQUEST'],
      [422, 'INVALID_MODEL_SETTINGS'],
      [409, 'MODEL_UNAVAILABLE'],
      [409, 'CATALOG_CHANGED'],
      [409, 'REFERENCE_DURATION_CHANGED'],
      [409, 'cost_changed'],
      [409, 'IDEMPOTENCY_KEY_REUSED'],
      [400, 'IDEMPOTENCY_KEY_REQUIRED'],
    ] as const) {
      expect(isAmbiguousWebStartFailure(refusal(status, code)), `${status} ${code}`).toBe(false);
    }
    expect(isAmbiguousWebStartFailure(refusal(401))).toBe(false);
    expect(isAmbiguousWebStartFailure(refusal(400))).toBe(false);
  });

  it('does not guess about errors that never came from a start', () => {
    expect(isAmbiguousWebStartFailure(new Error('Please log in to upload files.'))).toBe(false);
    expect(isAmbiguousWebStartFailure(null)).toBe(false);
    expect(isAmbiguousWebStartFailure('failed')).toBe(false);
  });
});

describe('pending web starts', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  function pendingStart(overrides: Partial<PendingWebStart> = {}): PendingWebStart {
    return {
      version: 1,
      tool: 'image',
      idempotencyKey: 'key-1',
      body: { kind: 'image', modelId: 'fixture-image', catalogRevision: 'rev-1', settings: {}, prompt: 'A fox' },
      catalogRevision: 'rev-1',
      createdAt: new Date().toISOString(),
      userId: 'user-1',
      ...overrides,
    };
  }

  it('hands back the saved key and body for that tool until it is cleared', () => {
    const start = pendingStart();
    expect(savePendingWebStart(start)).toBe(true);

    expect(loadPendingWebStart('image', 'user-1')).toEqual(start);
    expect(loadPendingWebStart('video', 'user-1')).toBeNull();

    clearPendingWebStart('image');
    expect(loadPendingWebStart('image', 'user-1')).toBeNull();
  });

  it('replays the same body the server hashed', () => {
    const start = pendingStart({ body: { kind: 'image', settings: { aspectRatio: '1:1' }, inputs: [{ slot: 'imageReferences', url: 'https://cdn.test/a.png' }] } });
    savePendingWebStart(start);

    expect(JSON.stringify(loadPendingWebStart('image')?.body)).toBe(JSON.stringify(start.body));
  });

  it('drops a start older than a day', () => {
    savePendingWebStart(pendingStart({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }));

    expect(loadPendingWebStart('image', 'user-1')).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('never hands one account the start another account saved in this tab', () => {
    savePendingWebStart(pendingStart({ userId: 'user-1' }));

    expect(loadPendingWebStart('image', 'user-2')).toBeNull();
    expect(loadPendingWebStart('image', 'user-1')).toBeNull();
  });

  it('drops a record it cannot read', () => {
    window.sessionStorage.setItem('magicbooklet:pending-generation-start:v1:image', '{"version":1,"tool":"image"}');
    expect(loadPendingWebStart('image')).toBeNull();
    expect(window.sessionStorage.length).toBe(0);

    window.sessionStorage.setItem('magicbooklet:pending-generation-start:v1:motion', 'not json');
    expect(loadPendingWebStart('motion')).toBeNull();
  });

  it('reports a refused write instead of throwing before the start is sent', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    expect(savePendingWebStart(pendingStart())).toBe(false);
  });
});

/**
 * The price a web start carries: the one the creator was shown, when it is a ready quote of
 * this very run. The start charges its own price up to it and refuses a run it prices above
 * it (`cost_changed`) before any credits are held. The app's rule is the same
 * (`catalogStartRequest` in ugc-mobile/lib/generation-model-draft.ts).
 */
describe('the price a web start carries', () => {
  const run: CatalogGenerationRequestPayload = {
    kind: 'video',
    modelId: 'seedance-2',
    catalogRevision: 'rev-1',
    settings: { duration: 5, aspectRatio: '16:9' },
    prompt: 'A dancer crosses a bright studio in the rhythm of the reference.',
    inputs: [{ slot: 'videoReferences', kind: 'video', url: 'https://signed.example.com/clip.mp4', durationSeconds: 4.2 }],
  };
  /** The quote request a creator asks a run's price with, as JSON. */
  const quoteKey = (priced: CatalogGenerationRequestPayload) => JSON.stringify(catalogRunQuoteInput({ ...priced, inputs: priced.inputs ?? [] }));
  const ready = (costCredits: number, key: string | null = quoteKey(run)) => ({ status: 'ready' as const, quote: { costCredits }, key });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries a ready quote of this very run', () => {
    expect(webCatalogStartRequest(run, ready(80))).toEqual({ ...run, expectedCostCredits: 80 });
    expect(webCatalogStartRequest(run, ready(0))).toEqual({ ...run, expectedCostCredits: 0 });
  });

  it.each(['idle', 'pending', 'error'] as const)('carries no price while the quote is %s, even one left from an earlier answer', (status) => {
    expect(webCatalogStartRequest(run, { status, quote: { costCredits: 80 }, key: quoteKey(run) })).toEqual(run);
  });

  it('carries no price quoted for another run', () => {
    const [reference] = run.inputs!;
    for (const other of [
      { ...run, settings: { ...run.settings, duration: 10 } },
      { ...run, inputs: [{ ...reference, durationSeconds: 8 }] },
      { ...run, inputs: [] },
      { ...run, modelId: 'seedance-2-5' },
      { ...run, catalogRevision: 'rev-2' },
    ]) {
      expect(webCatalogStartRequest(run, ready(80, quoteKey(other)))).toEqual(run);
    }
    expect(webCatalogStartRequest(run, ready(80, null))).toEqual(run);
  });

  it('reads a run by what its price reads, not by its prompt or links', () => {
    const [reference] = run.inputs!;
    const relinked = {
      ...run,
      prompt: 'Another prompt',
      inputs: [{ ...reference, url: 'https://signed.example.com/refreshed/clip.mp4', label: 'Dance clip', storagePath: 'uploads/user-1/clip.mp4' }],
    };
    expect(webCatalogStartRequest(relinked, ready(80))).toEqual({ ...relinked, expectedCostCredits: 80 });
  });

  it.each([12.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('carries no price of %s credits, which is no whole number of credits', (costCredits) => {
    expect(webCatalogStartRequest(run, ready(costCredits))).toEqual(run);
  });

  it('sends no price the start would refuse the whole run for', () => {
    // As the page would have sent them (JSON sends NaN and Infinity as null, which the start
    // reads as no price at all), the start refuses these, and the run with them.
    for (const costCredits of [12.5, -1, 2 ** 53]) {
      let refusal: unknown = null;
      try {
        parseUnifiedGenerationRequest(JSON.parse(JSON.stringify({ ...run, expectedCostCredits: costCredits })));
      } catch (error) {
        refusal = error;
      }
      expect(refusal, String(costCredits)).toMatchObject({ status: 422, fieldErrors: { expectedCostCredits: expect.any(String) } });
      expect(webCatalogStartRequest(run, ready(costCredits))).not.toHaveProperty('expectedCostCredits');
    }
    // What it does send, it reads back as sent.
    expect(parseUnifiedGenerationRequest(JSON.parse(JSON.stringify(webCatalogStartRequest(run, ready(80))))).expectedCostCredits).toBe(80);
  });

  it('is told by the quote hook which request each answer prices', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const asked = JSON.parse(String(init.body)) as { modelId: string; settings: { duration: number } };
      return jsonResponse({ modelId: asked.modelId, catalogRevision: 'rev-1', normalizedSettings: {}, costCredits: asked.settings.duration * 16 }, 200);
    }));
    const first = catalogRunQuoteInput({ ...run, inputs: run.inputs! });
    const second = { ...first, settings: { ...first.settings, duration: 10 } };
    const hook = renderHook(({ request }) => useWebGenerationModelQuote(request, 'token'), { initialProps: { request: first } });

    expect(hook.result.current).toMatchObject({ status: 'pending', key: JSON.stringify(first) });
    await waitFor(() => expect(hook.result.current).toMatchObject({ status: 'ready', quote: { costCredits: 80 }, key: JSON.stringify(first) }));

    hook.rerender({ request: second });
    // The first answer is not this request's, so it is not this request's price.
    expect(hook.result.current).toMatchObject({ status: 'pending', quote: null, key: JSON.stringify(second) });
    await waitFor(() => expect(hook.result.current).toMatchObject({ status: 'ready', quote: { costCredits: 160 }, key: JSON.stringify(second) }));
    hook.unmount();
  });
});
