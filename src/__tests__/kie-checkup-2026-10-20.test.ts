import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  catalogRunQuoteInput,
  type CatalogRunInputFact,
} from '../../ugc-mobile/lib/model-catalog/protocol';
import {
  IMAGE_MODELS as CLIENT_IMAGE_MODELS,
  getVideoElementSupport as getClientVideoElementSupport,
} from '@/lib/client-generation-models';
import { buildGenerationProviderRequest } from '@/lib/generation-model-adapters';
import { getVideoInputAffordances } from '@/lib/generation-model-affordances';
import {
  CatalogError,
  buildGenerationModelCatalog,
  quoteGenerationModel,
  type CatalogInputSlot,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import { IMAGE_MODELS, getVideoCost, getVideoElementSupport, type VideoModelId } from '@/lib/models';

/**
 * The 2026-10-20 check-up of every catalog model against Kie
 * (archive/model-checkup-2026-10-20/README.md). App credits are Kie credits 1:1, so each
 * price below is Kie's own line from that day (evidence/prices-all.txt), multiplied out and
 * rounded up the way the app bills, and each cap is the spec's.
 */

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = new Map(
  buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]),
);

function descriptor(modelId: string) {
  const found = catalog.models.find((model) => model.id === modelId);
  if (!found) throw new Error(`no descriptor for ${modelId}`);
  return found;
}

function slot(modelId: string, modeKey: string, slotKey: string): CatalogInputSlot {
  const mode = (descriptor(modelId).inputModes ?? []).find((candidate) => candidate.key === modeKey);
  const found = mode?.slots.find((candidate) => candidate.key === slotKey);
  if (!found) throw new Error(`no ${modeKey}/${slotKey} slot on ${modelId}`);
  return found;
}

function rules(modelId: string): Array<Record<string, unknown>> {
  return (operations.get(modelId)?.validationConfig.rules ?? []) as Array<Record<string, unknown>>;
}

function fieldErrorsFor(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.fieldErrors;
    throw error;
  }
  throw new Error('expected the quote to be refused');
}

/** A run's quote as both creators send it: settings plus the facts of every input. */
function runQuote(
  modelId: string,
  settings: Record<string, string | number | boolean>,
  inputs: CatalogRunInputFact[] = [],
  kind: 'image' | 'video' = 'video',
): GenerationModelQuoteInput {
  return catalogRunQuoteInput({ kind, modelId, catalogRevision: catalog.revision, settings, inputs });
}

function credits(input: GenerationModelQuoteInput): number {
  return quoteGenerationModel(input, { catalog }).costCredits;
}

const picture: CatalogRunInputFact = { slot: 'imageReferences', kind: 'image' };
const clip = (durationSeconds: number): CatalogRunInputFact => ({ slot: 'videoReferences', kind: 'video', durationSeconds });
const track = (durationSeconds: number): CatalogRunInputFact => ({ slot: 'audioReferences', kind: 'audio', durationSeconds });
const startFrame: CatalogRunInputFact = { slot: 'startFrame', kind: 'image' };
const times = (count: number, input: CatalogRunInputFact) => Array.from({ length: count }, () => input);

/**
 * Credits for `seconds` at a Kie rate of at most one decimal, rounded up. Worked in tenths
 * so the expected figure carries no floating-point error of its own.
 */
function billed(ratePerSecond: number, seconds: number): number {
  return Math.ceil((Math.round(ratePerSecond * 10) * seconds) / 10);
}

describe('Seedance prices equal Kie list prices after the offers ended', () => {
  // prices-all.txt: kie.ai/seedance-2-0 (Fast), kie.ai/seedance-2-0-mini, kie.ai/seedance-2-5.
  // The Fast and Mini "until October 7" offers and the 2.5 1080p "28% OFF until Oct 17"
  // offer ended with the prices kept, so these are the list prices now.
  const KIE_RATES: Record<'seedance-2-mini' | 'seedance-2-fast' | 'seedance-2-5', Record<string, { noVideo: number; withVideo: number }>> = {
    'seedance-2-mini': {
      '480p': { noVideo: 3.8, withVideo: 2.4 },
      '720p': { noVideo: 8.2, withVideo: 5.0 },
    },
    'seedance-2-fast': {
      '480p': { noVideo: 11.7, withVideo: 6.8 },
      '720p': { noVideo: 24.8, withVideo: 15 },
    },
    'seedance-2-5': {
      '480p': { noVideo: 28, withVideo: 17 },
      '720p': { noVideo: 63, withVideo: 38 },
      '1080p': { noVideo: 158, withVideo: 95 },
    },
  };

  describe.each(Object.keys(KIE_RATES) as Array<keyof typeof KIE_RATES>)('%s', (modelId) => {
    const maxSeconds = modelId === 'seedance-2-5' ? 30 : 15;
    const durations = Array.from({ length: maxSeconds - 3 }, (_, index) => index + 4);

    it.each(Object.keys(KIE_RATES[modelId]))('%s: every length quotes Kie\'s rate, with and without a clip', (resolution) => {
      const rates = KIE_RATES[modelId][resolution];
      for (const duration of durations) {
        const settings = { aspectRatio: '16:9', resolution, duration };
        expect(credits(runQuote(modelId, settings)), `${duration} s`).toBe(billed(rates.noVideo, duration));
        // With a clip Kie bills output plus input seconds at the with-video rate.
        expect(
          credits(runQuote(modelId, { ...settings, referenceMode: 'elements' }, [clip(5)])),
          `${duration} s + a 5 s clip`,
        ).toBe(billed(rates.withVideo, duration + 5));
        // The start path's own figure, for a start that arrives without a quote.
        expect(getVideoCost(modelId, { resolution, durationSeconds: duration }), `${duration} s start`).toBe(billed(rates.noVideo, duration));
        expect(getVideoCost(modelId, { resolution, durationSeconds: duration, hasReferenceVideo: true }), `${duration} s start, clip`)
          .toBe(billed(rates.withVideo, duration));
      }
    });
  });

  it('quotes the check-up\'s worked examples', () => {
    // evidence/agent-reports/V2.md, ours vs Kie on 2026-10-20.
    expect(credits(runQuote('seedance-2-mini', { aspectRatio: '16:9', resolution: '480p', duration: 10 }))).toBe(38);
    expect(credits(runQuote('seedance-2-mini', { aspectRatio: '16:9', resolution: '720p', duration: 15 }))).toBe(123);
    expect(credits(runQuote('seedance-2-mini', { aspectRatio: '16:9', resolution: '720p', duration: 15, referenceMode: 'elements' }, [clip(5)]))).toBe(100);
    expect(credits(runQuote('seedance-2-fast', { aspectRatio: '16:9', resolution: '480p', duration: 15 }))).toBe(176);
    expect(credits(runQuote('seedance-2-fast', { aspectRatio: '16:9', resolution: '720p', duration: 15 }))).toBe(372);
    expect(credits(runQuote('seedance-2-fast', { aspectRatio: '16:9', resolution: '720p', duration: 15, referenceMode: 'elements' }, [clip(5)]))).toBe(300);
    expect(credits(runQuote('seedance-2-5', { aspectRatio: '16:9', resolution: '1080p', duration: 5 }))).toBe(790);
    expect(credits(runQuote('seedance-2-5', { aspectRatio: '16:9', resolution: '1080p', duration: 30 }))).toBe(4740);
    expect(credits(runQuote('seedance-2-5', { aspectRatio: '16:9', resolution: '1080p', duration: 5, referenceMode: 'elements' }, [clip(5)]))).toBe(950);
  });
});

describe('PixVerse V6 bills a reference run like any other run', () => {
  // prices-all.txt: kie.ai/pixverse-v6 now prints the same block for text-to-video,
  // image-to-video, transition, reference-to-video and extend.
  const KIE_RATES: Record<string, { noSound: number; withSound: number }> = {
    '360p': { noSound: 4.0, withSound: 5.6 },
    '540p': { noSound: 5.6, withSound: 7.2 },
    '720p': { noSound: 7.2, withSound: 9.6 },
    '1080p': { noSound: 14.4, withSound: 18.4 },
  };

  it.each(Object.keys(KIE_RATES))('%s: references, frames and text all quote Kie\'s one table', (resolution) => {
    for (const sound of [false, true]) {
      const rate = sound ? KIE_RATES[resolution].withSound : KIE_RATES[resolution].noSound;
      for (const duration of [1, 5, 10, 15]) {
        const settings = { aspectRatio: '16:9', resolution, duration, sound };
        const expected = billed(rate, duration);
        expect(credits(runQuote('pixverse-v6', settings)), `text ${duration} s`).toBe(expected);
        expect(credits(runQuote('pixverse-v6', { ...settings, referenceMode: 'elements' }, [picture])), `1 reference, ${duration} s`).toBe(expected);
        expect(credits(runQuote('pixverse-v6', { ...settings, referenceMode: 'elements' }, times(7, picture))), `7 references, ${duration} s`).toBe(expected);
        expect(credits(runQuote('pixverse-v6', { ...settings, referenceMode: 'frames' }, [startFrame, { slot: 'endFrame', kind: 'image' }])), `frame pair, ${duration} s`).toBe(expected);
        for (const hasReusableReference of [false, true]) {
          expect(getVideoCost('pixverse-v6', { resolution, durationSeconds: duration, sound, hasReusableReference }), `start ${duration} s`).toBe(expected);
        }
      }
    }
  });

  it('prices the check-up\'s worked examples at Kie\'s figure', () => {
    // V2.md: 1080p 15 s with sound was 311 against Kie's 276; 360p 5 s was 23 against 20.
    expect(credits(runQuote('pixverse-v6', { aspectRatio: '16:9', resolution: '1080p', duration: 15, sound: true, referenceMode: 'elements' }, [picture]))).toBe(276);
    expect(credits(runQuote('pixverse-v6', { aspectRatio: '16:9', resolution: '360p', duration: 5, referenceMode: 'elements' }, [picture]))).toBe(20);
  });

  it('prices with one expression, not a reference branch', () => {
    expect(operations.get('pixverse-v6')?.pricingStrategy).toBe('per-second');
  });
});

describe('MiniMax H3 takes the five reference images Kie includes', () => {
  // prices-all.txt: "Additional image input: 4 credits/image … The first 5 images are free".
  // The app adds no image charge, so it stops at five instead.
  it('publishes, quotes and starts at most five', () => {
    expect(descriptor('minimax-h3').inputs.imageReferences?.max).toBe(5);
    expect(slot('minimax-h3', 'references', 'imageReferences').max).toBe(5);
    expect(getVideoElementSupport('minimax-h3')).toMatchObject({ enabled: true, maxElements: 5, maxNamed: 5 });
    expect(getClientVideoElementSupport('minimax-h3')).toMatchObject({ enabled: true, maxElements: 5, maxNamed: 5 });
    expect(rules('minimax-h3')).toContainEqual(expect.objectContaining({ type: 'max-slot-count', slotKey: 'images', max: 5 }));
  });

  it('prices five pictures at the plain per-second rate and refuses a sixth', () => {
    const settings = { aspectRatio: '16:9', resolution: '768P', duration: 6, referenceMode: 'elements' };
    expect(credits(runQuote('minimax-h3', settings, times(5, picture)))).toBe(48);
    expect(Object.keys(fieldErrorsFor(() => credits(runQuote('minimax-h3', settings, times(6, picture)))))).not.toHaveLength(0);
  });

  it('keeps its clip and track caps', () => {
    expect(descriptor('minimax-h3').inputs.videoReferences?.max).toBe(3);
    expect(descriptor('minimax-h3').inputs.audioReferences?.max).toBe(3);
  });
});

describe('Nano Banana 2 takes ten references and no Google Search', () => {
  // docs.kie.ai/market/google/nanobanana2.md, 2026-10-20: image_input maxItems 10; the input
  // schema lists prompt, image_input, aspect_ratio, resolution and output_format only.
  it('publishes and quotes at most ten references', () => {
    expect(IMAGE_MODELS['nano-banana-2'].maxImages).toBe(10);
    expect(CLIENT_IMAGE_MODELS['nano-banana-2'].maxImages).toBe(10);
    expect(descriptor('nano-banana-2').inputs.imageReferences?.max).toBe(10);
    expect(slot('nano-banana-2', 'references', 'imageReferences').max).toBe(10);
    const settings = { aspectRatio: '1:1', resolution: '1K' };
    expect(credits(runQuote('nano-banana-2', settings, times(10, picture), 'image'))).toBe(8);
    expect(fieldErrorsFor(() => credits(runQuote('nano-banana-2', settings, times(11, picture), 'image'))))
      .toHaveProperty('references');
  });

  it('offers no Google Search control or grounding on any image model', () => {
    for (const model of catalog.models.filter((candidate) => candidate.kind === 'image')) {
      expect(model.controls.map((control) => control.key), model.id).not.toContain('googleSearch');
      expect(model.capabilities.googleSearch, model.id).toBe(false);
    }
    expect(IMAGE_MODELS['nano-banana-2'].supportsGoogleSearch).toBe(false);
    expect(CLIENT_IMAGE_MODELS['nano-banana-2'].supportsGoogleSearch).toBe(false);
    for (const description of [descriptor('nano-banana-2').description, CLIENT_IMAGE_MODELS['nano-banana-2'].description]) {
      expect(description).not.toMatch(/google|search|grounding/i);
    }
  });

  it.each(['nano-banana-2', 'nano-banana-pro'])('%s: never sends google_search, whatever the settings say', (modelId) => {
    const operation = operations.get(modelId)!;
    expect(operation.adapterKey).toBe('kie-task-v1');
    expect(Object.keys((operation.adapterConfig as { settings: Record<string, unknown> }).settings)).not.toContain('googleSearch');
    for (const googleSearch of [true, false]) {
      const request = buildGenerationProviderRequest({
        operation,
        prompt: 'A ceramic mug',
        settings: { aspectRatio: '1:1', resolution: '2K', outputFormat: 'png', googleSearch },
        inputs: [],
      });
      expect(request.body).toEqual({
        model: modelId,
        input: { prompt: 'A ceramic mug', aspect_ratio: '1:1', resolution: '2K', output_format: 'png' },
      });
    }
  });

  describe('an installed app or a saved draft that still sends googleSearch', () => {
    // Apps on catalog schemas 1 and 2 read the published descriptor; one that cached the
    // old one, and every draft saved with the toggle, still sends the key. The quote reads
    // only what the descriptor declares, so the value is dropped, never refused.
    it.each([1, 2, 3])('quotes on a schema-%s catalog, with the value ignored', (schemaVersion) => {
      const projected = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion });
      for (const modelId of ['nano-banana-2', 'nano-banana-pro']) {
        for (const googleSearch of [true, false, 'on', 1]) {
          const quote = quoteGenerationModel({
            kind: 'image',
            modelId,
            schemaVersion,
            settings: { aspectRatio: '1:1', resolution: '1K', outputFormat: 'jpg', googleSearch },
            inputCounts: { images: 1 },
            catalogRevision: projected.revision,
          }, { catalog: projected });
          expect(quote.costCredits, `${modelId} ${String(googleSearch)}`).toBe(modelId === 'nano-banana-2' ? 8 : 18);
          expect(quote.normalizedSettings.googleSearch, `${modelId} ${String(googleSearch)}`).toBe(false);
        }
      }
    });
  });
});

describe('Gemini reference clips stop at 30 seconds', () => {
  // gemini-omni-flash-1-1.md:211-212,239 and gemini-omni-video.md:176-177,203: the source
  // video "must not exceed 30s".
  it.each(['gemini-omni-video', 'gemini-omni-1.1-flash'])('%s: publishes the cap and refuses a longer clip', (modelId) => {
    const videoSlot = slot(modelId, 'references', 'videoReferences');
    expect(videoSlot.maxDurationSeconds).toBe(30);
    // The ceiling is enforceable only when every clip reports its length.
    expect(videoSlot.durationMetadata).toBe('required');
    expect(rules(modelId)).toContainEqual(expect.objectContaining({ type: 'combined-duration', slotKeys: ['videoReferences'], max: 30 }));
    const settings = { aspectRatio: '16:9', resolution: '720p', duration: 8, referenceMode: 'elements' };
    expect(credits(runQuote(modelId, settings, [clip(30)]))).toBe(168);
    expect(Object.values(fieldErrorsFor(() => credits(runQuote(modelId, settings, [clip(31)])))).join(' ')).toMatch(/30 seconds/);
  });

  it.each(['gemini-omni-video', 'gemini-omni-1.1-flash'] as const)('%s: the creators show the cap before and after the catalog loads', (modelId) => {
    const settings = { referenceMode: 'elements' };
    expect(getVideoInputAffordances(descriptor(modelId), modelId, settings).referenceVideos.maxDurationSeconds).toBe(30);
    expect(getVideoInputAffordances(null, modelId, settings).referenceVideos.maxDurationSeconds).toBe(30);
  });
});

describe('Seedance 2.5 reference audio stops at 30 seconds in total', () => {
  // seedance-2-5.md:259-261: "total duration of reference audio must not exceed 30 seconds".
  const settings = { aspectRatio: '16:9', resolution: '480p', duration: 5, referenceMode: 'elements' };

  it('refuses tracks that add up to more than 30 seconds and takes 30', () => {
    expect(rules('seedance-2-5')).toContainEqual(expect.objectContaining({ type: 'combined-duration', slotKeys: ['audioReferences'], max: 30 }));
    expect(Object.values(fieldErrorsFor(() => credits(runQuote('seedance-2-5', settings, [picture, track(20), track(15)])))).join(' '))
      .toMatch(/Reference audio may be at most 30 seconds in total/);
    expect(credits(runQuote('seedance-2-5', settings, [picture, track(15), track(15)]))).toBe(140);
    // Each track still stops at 30 on its own.
    expect(slot('seedance-2-5', 'references', 'audioReferences').maxDurationSeconds).toBe(30);
  });
});

describe('Wan 2.7 reference voice', () => {
  // 2-7-r2v.md:162-166: reference_voice "Duration: 1 to 10 seconds"; :116-119: "At least one
  // of reference_image or reference_video must be provided".
  const settings = { aspectRatio: '16:9', resolution: '720p', duration: 5, referenceMode: 'elements' };

  it('publishes a 10-second voice and refuses a longer one', () => {
    expect(slot('wan-2.7', 'references', 'audioReferences').maxDurationSeconds).toBe(10);
    // Clips carry no length cap on r2v; only the voice does.
    expect(slot('wan-2.7', 'references', 'videoReferences').maxDurationSeconds).toBeUndefined();
    expect(rules('wan-2.7')).toContainEqual(expect.objectContaining({ type: 'combined-duration', slotKeys: ['audioReferences'], max: 10 }));
    expect(credits(runQuote('wan-2.7', settings, [picture, track(10)]))).toBe(80);
    expect(Object.values(fieldErrorsFor(() => credits(runQuote('wan-2.7', settings, [picture, track(11)])))).join(' ')).toMatch(/10 seconds/);
  });

  it('refuses a references run whose only reference is the voice, with or without a start frame', () => {
    for (const inputs of [[track(5)], [track(5), startFrame]]) {
      expect(Object.values(fieldErrorsFor(() => credits(runQuote('wan-2.7', settings, inputs)))).join(' '))
        .toMatch(/reference image or video/);
    }
    expect(credits(runQuote('wan-2.7', settings, [picture, track(5)]))).toBe(80);
    expect(credits(runQuote('wan-2.7', settings, [clip(3), track(5)]))).toBe(80);
    expect(credits(runQuote('wan-2.7', settings, [picture, track(5), startFrame]))).toBe(80);
    // Reuses the rule type MiniMax H3 states the same contract with.
    expect(rules('wan-2.7')).toContainEqual(expect.objectContaining({
      type: 'forbidden-combination',
      field: 'audios',
      conditions: [
        { source: 'inputCount', key: 'audioReferences', operator: 'greaterThan', value: 0 },
        { source: 'inputCount', key: 'imageReferences', operator: 'equals', value: 0 },
        { source: 'inputCount', key: 'videoReferences', operator: 'equals', value: 0 },
      ],
    }));
  });
});

describe('Veo 3.1 reference runs', () => {
  // veo3 spec :43-52: REFERENCE_2_VIDEO "supports 16:9 & 9:16".
  const references = { mode: 'veo3_fast', resolution: '720p', referenceMode: 'elements' };

  it('take 16:9 or 9:16 only', () => {
    expect(fieldErrorsFor(() => credits(runQuote('veo-3.1', { ...references, aspectRatio: 'Auto' }, [picture]))))
      .toHaveProperty('aspectRatio', 'Veo 3.1 renders reference runs at 16:9 or 9:16 only.');
    expect(credits(runQuote('veo-3.1', { ...references, aspectRatio: '16:9' }, [picture]))).toBe(60);
    expect(credits(runQuote('veo-3.1', { ...references, mode: 'veo3_lite', aspectRatio: '9:16' }, times(3, picture)))).toBe(30);
  });

  it('keeps Auto for text and frame runs', () => {
    expect(credits(runQuote('veo-3.1', { mode: 'veo3_fast', resolution: '720p', aspectRatio: 'Auto' }))).toBe(60);
    expect(credits(runQuote('veo-3.1', { mode: 'veo3_fast', resolution: '720p', aspectRatio: 'Auto', referenceMode: 'frames' }, [startFrame]))).toBe(60);
  });
});

// From the request body to the provider request, with the catalog's quote and the real
// start services: what a phone or a page sends is quoted, measured and sent as above.
describe('a run the provider is sent', () => {
  const REFERENCE = 'https://signed.example.com/uploads/user-1/reference.png';
  const CLIP = 'https://signed.example.com/uploads/user-1/reference.mp4';
  const VOICE = 'https://signed.example.com/uploads/user-1/voice.mp3';

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

  function adminClient() {
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
    const from = vi.fn(() => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    });
    return { rpc, from };
  }

  function recordProviderRequests(): Array<Record<string, unknown>> {
    const requests: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') requests.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'provider-task-1' } }) } as Response;
    });
    return requests;
  }

  async function start(body: Record<string, unknown>, measuredSeconds = 4) {
    const { startUnifiedGenerationForRoute } = await import('@/lib/unified-generation-start-service');
    const { startCatalogGeneration, startVideoGeneration } = await import('@/lib/generation-services');
    const { loadPublishedGenerationModelCatalog } = await import('@/lib/generation-model-catalog-store');
    const { catalog: published } = await loadPublishedGenerationModelCatalog({ platform: 'mobile', schemaVersion: 2 });
    const requests = recordProviderRequests();
    const admin = adminClient();
    const outcome = await startUnifiedGenerationForRoute(
      {
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': `checkup-${String(body.modelId)}`, 'x-magicbooklet-client': 'mobile' },
        }),
        body: { ...body, catalogRevision: published.revision },
        userId: 'user-1',
        callerIsGuest: false,
        supabase: {} as never,
        adminSupabase: admin as never,
      },
      {
        resolveSource: vi.fn(async () => null) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
        resolveInputSource: vi.fn(async (_client: unknown, url: string) => url),
        probeInputDuration: vi.fn(async () => measuredSeconds),
        startCatalog: (params) => startCatalogGeneration({ ...params, persistInputMedia: false }),
        startVideo: (params) => startVideoGeneration({ ...params, persistInputMedia: false }),
      },
    ).then((value) => ({ value }), (error: unknown) => ({ error }));
    const reservation = admin.rpc.mock.calls.find(([fn]) => fn === 'start_generation')?.[1];
    return { outcome, request: requests[0], reservation };
  }

  it('starts a Nano Banana run that still sends googleSearch, and sends Kie no google_search', async () => {
    const { outcome, request } = await start({
      kind: 'image',
      modelId: 'nano-banana-2',
      prompt: 'A ceramic mug on a marble counter.',
      settings: { aspectRatio: '1:1', resolution: '1K', outputFormat: 'jpg', googleSearch: true },
      inputs: [{ slot: 'imageReferences', kind: 'image', url: REFERENCE, storagePath: 'uploads/user-1/reference.png' }],
    });

    expect(outcome).toMatchObject({ value: { success: true, predictionId: 'provider-task-1', cost: 8 } });
    expect(request).toMatchObject({ model: 'nano-banana-2', input: { image_input: [REFERENCE] } });
    expect((request?.input as Record<string, unknown>) ?? {}).not.toHaveProperty('google_search');
  });

  it('measures a Gemini clip and refuses one over 30 seconds before anything is held', async () => {
    const body = {
      kind: 'video',
      modelId: 'gemini-omni-1.1-flash',
      prompt: 'Follow the move in the clip.',
      shots: [],
      settings: { aspectRatio: '16:9', resolution: '720p', duration: 8, referenceMode: 'elements' },
      // The app reports 12 s; the server measures the file it would send.
      inputs: [{ slot: 'videoReferences', kind: 'video', url: CLIP, storagePath: 'uploads/user-1/reference.mp4', durationSeconds: 12 }],
    };

    const refused = await start(body, 31);
    expect(refused.outcome).toMatchObject({ error: { code: 'INVALID_MODEL_SETTINGS' } });
    expect(refused.reservation).toBeUndefined();
    expect(refused.request).toBeUndefined();

    const accepted = await start(body, 12);
    expect(accepted.outcome).toMatchObject({ value: { success: true, cost: 168 } });
    expect(accepted.request).toMatchObject({ model: 'google/gemini-omni-flash-1-1' });
  });

  it('measures a Wan 2.7 voice and refuses one over 10 seconds, or one sent alone', async () => {
    const run = (inputs: Array<Record<string, unknown>>) => ({
      kind: 'video',
      modelId: 'wan-2.7',
      prompt: 'The lead says hello.',
      shots: [],
      settings: { aspectRatio: '16:9', resolution: '720p', duration: 5, referenceMode: 'elements' },
      inputs,
    });
    const voice = { slot: 'audioReferences', kind: 'audio', url: VOICE, storagePath: 'uploads/user-1/voice.mp3' };
    const image = { slot: 'imageReferences', kind: 'image', url: REFERENCE, storagePath: 'uploads/user-1/reference.png' };

    const tooLong = await start(run([image, voice]), 11);
    expect(tooLong.outcome).toMatchObject({ error: { code: 'INVALID_MODEL_SETTINGS' } });
    expect(tooLong.request).toBeUndefined();

    const alone = await start(run([voice]), 5);
    expect(alone.outcome).toMatchObject({ error: { code: 'INVALID_MODEL_SETTINGS' } });
    expect(alone.request).toBeUndefined();

    const accepted = await start(run([image, voice]), 5);
    expect(accepted.outcome).toMatchObject({ value: { success: true, cost: 80 } });
    expect(accepted.request).toMatchObject({
      model: 'wan/2-7-r2v',
      input: { reference_image: [REFERENCE], reference_voice: VOICE },
    });
  });
});

describe('the hand-written image start', () => {
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

  it.each(['nano-banana-2', 'nano-banana-pro'] as const)('%s: sends no google_search from the ladder either', async (modelId) => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const requests: Array<Record<string, unknown>> = [];
    vi.mocked(fetch).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') requests.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ code: 200, data: { taskId: 'provider-task-1' } }) } as Response;
    });
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'start_generation') {
        return { data: { status: 'started', generation_id: 'generation-1', remaining_credits: 100, cost: args.p_cost }, error: null };
      }
      if (fn === 'attach_generation_provider_task') {
        return { data: { status: 'attached', generation_id: 'generation-1' }, error: null };
      }
      return { data: true, error: null };
    });
    // The ladder runs when a model's published entry is still on image-v1.
    const ladder = { ...operations.get(modelId)!, adapterKey: 'image-v1' as const, adapterConfig: {} };

    await startImageGeneration({
      supabase: { rpc } as never,
      creditSupabase: { rpc } as never,
      userId: 'user-1',
      prompt: 'A ceramic mug on a marble counter.',
      model: modelId,
      aspectRatio: '1:1',
      resolution: '1K',
      outputFormat: 'jpg',
      googleSearch: true,
      persistInputMedia: false,
      operationalConfig: ladder,
    });

    expect(requests[0]).toMatchObject({ model: modelId, input: { prompt: 'A ceramic mug on a marble counter.', aspect_ratio: '1:1' } });
    expect(requests[0]?.input).not.toHaveProperty('google_search');
  });
});

const VIDEO_MODEL_IDS = catalog.models.filter((model) => model.kind === 'video').map((model) => model.id as VideoModelId);

describe('the browser fallback agrees with the descriptor on clip length', () => {
  it.each(VIDEO_MODEL_IDS)('%s', (modelId) => {
    const settings = { referenceMode: 'elements', mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined };
    expect(getVideoInputAffordances(null, modelId, settings).referenceVideos.maxDurationSeconds)
      .toBe(getVideoInputAffordances(descriptor(modelId), modelId, settings).referenceVideos.maxDurationSeconds);
  });
});
