import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCodeGenerationModelOperations,
  calculateGenerationModelRuntimeCost,
  type GenerationModelOperationalConfig,
  type GenerationModelRuntimeInputs,
} from '@/lib/generation-model-runtime';
import { getVideoCost } from '@/lib/models';
import {
  VEO_JOBS_MODEL_ID,
  VEO_JOBS_PROVIDER_API_SETTINGS,
  buildVeoJobsTaskBody,
  readVeoJobsResultUrl,
  readVeoProviderApi,
  veoJobsTier,
} from '@/lib/veo-provider-api';

// Kie moved Veo 3.1 to its unified market API (docs/veo3-api/generate-veo-3-video.md,
// read 2026-10-20): POST /api/v1/jobs/createTask with model "veo-3-1" and everything
// else in `input`, snake_cased. The legacy POST /api/v1/veo/generate took the same
// fields flat (imageUrls, generationType, model = the tier). These pin the move.

const START = 'https://signed.example.com/uploads/user-1/start.png';
const END = 'https://signed.example.com/uploads/user-1/end.png';
const REFERENCES = [
  'https://signed.example.com/uploads/user-1/hero.png',
  'https://signed.example.com/uploads/user-1/bottle.png',
];

function body(overrides: Partial<Parameters<typeof buildVeoJobsTaskBody>[0]> = {}) {
  return buildVeoJobsTaskBody({
    prompt: 'A calm ocean at sunrise.',
    providerModelId: 'veo3_lite',
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
    referenceImageUrls: [],
    frameImageUrls: [],
    ...overrides,
  });
}

describe('the Veo 3.1 jobs-API task body', () => {
  it('sends a text run as model veo-3-1 with the tier, mode and settings inside input', () => {
    expect(VEO_JOBS_MODEL_ID).toBe('veo-3-1');
    expect(body()).toEqual({
      model: 'veo-3-1',
      input: {
        prompt: 'A calm ocean at sunrise.',
        model: 'veo3_lite',
        generation_type: 'TEXT_2_VIDEO',
        aspect_ratio: '16:9',
        resolution: '720p',
        duration: 8,
        enable_translation: true,
      },
    });
  });

  it('sends a start frame alone as a one-image FIRST_AND_LAST_FRAMES_2_VIDEO run', () => {
    expect(body({ providerModelId: 'veo3_fast', frameImageUrls: [START] })).toEqual({
      model: 'veo-3-1',
      input: {
        prompt: 'A calm ocean at sunrise.',
        model: 'veo3_fast',
        generation_type: 'FIRST_AND_LAST_FRAMES_2_VIDEO',
        image_urls: [START],
        aspect_ratio: '16:9',
        resolution: '720p',
        duration: 8,
        enable_translation: true,
      },
    });
  });

  it('sends a start and an end frame in that order', () => {
    expect(body({ providerModelId: 'veo3', resolution: '4k', frameImageUrls: [START, END] }).input).toEqual({
      prompt: 'A calm ocean at sunrise.',
      model: 'veo3',
      generation_type: 'FIRST_AND_LAST_FRAMES_2_VIDEO',
      image_urls: [START, END],
      aspect_ratio: '16:9',
      resolution: '4k',
      duration: 8,
      enable_translation: true,
    });
  });

  it('sends reference pictures as REFERENCE_2_VIDEO, as the legacy body did ahead of any frame', () => {
    expect(body({
      providerModelId: 'veo3_fast',
      aspectRatio: '9:16',
      resolution: '1080p',
      referenceImageUrls: REFERENCES,
      frameImageUrls: [START],
    }).input).toEqual({
      prompt: 'A calm ocean at sunrise.',
      model: 'veo3_fast',
      generation_type: 'REFERENCE_2_VIDEO',
      image_urls: REFERENCES,
      aspect_ratio: '9:16',
      resolution: '1080p',
      duration: 8,
      enable_translation: true,
    });
  });

  it('passes Auto through in the spelling both APIs list', () => {
    expect(body({ aspectRatio: 'Auto', frameImageUrls: [START] }).input.aspect_ratio).toBe('Auto');
  });

  it('keeps the legacy endpoint\'s translation default by asking for it', () => {
    // The legacy /api/v1/veo/generate translated prompts to English unless told not to
    // (`enableTranslation`, default true: docs/model-api-references/veo-3-1.md). The jobs
    // API documents no default for `enable_translation`, so the body says so itself; a
    // Hindi or Spanish prompt reaches Veo as it did before the move.
    expect(body().input.enable_translation).toBe(true);
  });

  it('carries none of the legacy flat fields, and nothing the legacy body did not send', () => {
    const sent = body({ referenceImageUrls: REFERENCES });
    expect(Object.keys(sent).sort()).toEqual(['input', 'model']);
    for (const legacy of ['prompt', 'imageUrls', 'generationType', 'aspect_ratio', 'aspectRatio', 'resolution']) {
      expect(sent).not.toHaveProperty(legacy);
    }
    // The app never sent a watermark, a seed or a fallback flag.
    for (const unsent of ['watermark', 'seeds', 'seed', 'enable_fallback', 'enableTranslation', 'imageUrls', 'generationType']) {
      expect(sent.input).not.toHaveProperty(unsent);
    }
  });
});

describe('the Veo 3.1 tier', () => {
  // Production's providerModelMap for veo-3.1 is { veo3, veo3_fast, veo3_lite,
  // default: veo3_fast }: the mode ids, which are also the jobs API's input.model enum.
  it.each([
    ['veo3', 'veo3'],
    ['veo3_fast', 'veo3_fast'],
    ['veo3_lite', 'veo3_lite'],
  ])('sends the catalog value %s as input.model %s', (providerModelId, tier) => {
    expect(veoJobsTier(providerModelId)).toBe(tier);
    expect(body({ providerModelId }).input.model).toBe(tier);
  });

  it.each(['veo-3-1', 'veo3_quality', 'Veo3', '', ' veo3_fast'])(
    'refuses %j rather than send a tier Kie does not list',
    (providerModelId) => {
      expect(() => veoJobsTier(providerModelId)).toThrow(/Veo 3\.1/);
      expect(() => body({ providerModelId })).toThrow(/Veo 3\.1/);
    },
  );
});

describe('which Kie API a Veo generation is on', () => {
  it('reads the marker a jobs-API start writes', () => {
    expect(VEO_JOBS_PROVIDER_API_SETTINGS).toEqual({ providerApi: 'jobs' });
    expect(readVeoProviderApi(VEO_JOBS_PROVIDER_API_SETTINGS)).toBe('jobs');
    expect(readVeoProviderApi({ model: 'veo-3.1', mode: 'veo3_fast', ...VEO_JOBS_PROVIDER_API_SETTINGS })).toBe('jobs');
  });

  // Every row written before this change has no marker: it was started on
  // /api/v1/veo/generate and must keep being read there.
  it.each([
    ['no settings', null],
    ['undefined settings', undefined],
    ['an empty (template) recipe', {}],
    ['a recipe with no marker', { model: 'veo-3.1', mode: 'veo3_fast', aspectRatio: '16:9' }],
    ['a marker in another case', { providerApi: 'JOBS' }],
    ['a marker that is not a string', { providerApi: true }],
    ['some other marker value', { providerApi: 'legacy' }],
    ['a string instead of an object', 'jobs'],
    ['an array', [{ providerApi: 'jobs' }]],
  ])('reads %s as the legacy API', (_label, settings) => {
    expect(readVeoProviderApi(settings)).toBe('legacy');
  });
});

describe('the video a finished jobs-API Veo task produced', () => {
  it('reads the market shape, resultJson.resultUrls', () => {
    expect(readVeoJobsResultUrl({
      state: 'success',
      resultJson: JSON.stringify({ resultUrls: ['https://tempfile.example.com/veo.mp4'] }),
    })).toBe('https://tempfile.example.com/veo.mp4');
  });

  it('reads the rendered 1080p/4k list in resultJson.data.result_urls before its 720p origin list', () => {
    // generate-veo-3-video.md, `resolution`: "For 1080p and 4k, the video URL is in
    // resultJson.data.result_urls (the 720p version is in data.origin_urls)".
    expect(readVeoJobsResultUrl({
      state: 'success',
      resultJson: JSON.stringify({
        data: {
          origin_urls: ['https://tempfile.example.com/veo-720p.mp4'],
          result_urls: ['https://tempfile.example.com/veo-4k.mp4'],
        },
      }),
    })).toBe('https://tempfile.example.com/veo-4k.mp4');
  });

  it('reads the 1080p record Kie returned on 2026-10-20, as Kie shaped it', () => {
    // The approved paid Lite 1080p run (archive/model-checkup-2026-10-20/fixes/
    // veo-new-api-probe-1080p-run.log): the rendered list and the original sit side by side
    // in resultJson.data and again in `response.data`, each beside its own nested JSON.
    const data = {
      origin_urls: ['https://tempfile.example.com/veo-720p-origin.mp4'],
      aspect_ratio: '16:9',
      media_ids: ['media-1'],
      seeds: [36921],
      high_resolution_pending: false,
      image_urls: ['https://tempfile.example.com/veo-poster.jpg'],
      high_resolution_child_task_id: 'child-task-1',
      result_urls: ['https://tempfile.example.com/veo-1080p.mp4'],
      has_audio_list: [true],
      resolution: '1080p',
    };
    const original = JSON.stringify({
      code: 200,
      data: { image_urls: data.image_urls, result_urls: ['https://tempfile.example.com/veo-720p-render.mp4'] },
      message_type: 'success',
      message: 'success',
    });
    const envelope = { code: 200, data, original_result_json: original, message_type: 'success', message: 'success' };

    expect(readVeoJobsResultUrl({
      state: 'success',
      resultJson: JSON.stringify(envelope),
      response: envelope,
    })).toBe('https://tempfile.example.com/veo-1080p.mp4');
  });

  it('prefers that documented high-resolution list over a top-level list', () => {
    expect(readVeoJobsResultUrl({
      resultJson: JSON.stringify({
        resultUrls: ['https://tempfile.example.com/veo-720p.mp4'],
        data: { result_urls: ['https://tempfile.example.com/veo-1080p.mp4'] },
      }),
    })).toBe('https://tempfile.example.com/veo-1080p.mp4');
  });

  it('reads an already-parsed resultJson and the parsed `response` Kie also returns', () => {
    expect(readVeoJobsResultUrl({
      resultJson: { result_urls: ['https://tempfile.example.com/object.mp4'] },
    })).toBe('https://tempfile.example.com/object.mp4');
    expect(readVeoJobsResultUrl({
      resultJson: '',
      response: { resultUrls: ['https://tempfile.example.com/response.mp4'] },
    })).toBe('https://tempfile.example.com/response.mp4');
  });

  it('reads the Veo callback shape, info.resultUrls', () => {
    // veo3-api/generate-veo-3-video-callbacks.md success example.
    expect(readVeoJobsResultUrl({
      taskId: 'veo_task_abcdef123456',
      info: {
        resultUrls: ['https://tempfile.example.com/callback.mp4'],
        originUrls: ['https://tempfile.example.com/callback-origin.mp4'],
        resolution: '1080p',
      },
      creditsConsumed: 60,
    })).toBe('https://tempfile.example.com/callback.mp4');
  });

  it('falls back to an origin list only when no result list has a URL, as the legacy reader did', () => {
    expect(readVeoJobsResultUrl({
      resultJson: JSON.stringify({ resultUrls: [], data: { origin_urls: ['https://tempfile.example.com/origin.mp4'] } }),
    })).toBe('https://tempfile.example.com/origin.mp4');
    expect(readVeoJobsResultUrl({
      resultJson: JSON.stringify({ originUrls: ['https://tempfile.example.com/origin-camel.mp4'] }),
    })).toBe('https://tempfile.example.com/origin-camel.mp4');
  });

  it('reads a list Kie sends as a JSON string, as the legacy reader did', () => {
    expect(readVeoJobsResultUrl({
      resultJson: JSON.stringify({ resultUrls: '["https://tempfile.example.com/string-list.mp4"]' }),
    })).toBe('https://tempfile.example.com/string-list.mp4');
  });

  it('keeps polling while Kie still renders the 1080p or 4k file, instead of delivering its 720p original', () => {
    // The live 1080p record (2026-10-20) carries `high_resolution_pending` beside the two
    // lists. While it is true the record holds only the 720p original, and settling that
    // would charge the 4k price for a 720p file: the next poll finds the render.
    const pending = {
      state: 'success',
      resultJson: JSON.stringify({
        data: {
          origin_urls: ['https://tempfile.example.com/veo-720p.mp4'],
          result_urls: [],
          high_resolution_pending: true,
          resolution: '4k',
        },
      }),
    };
    expect(readVeoJobsResultUrl(pending)).toBeNull();
    expect(readVeoJobsResultUrl(pending, 'https://tempfile.example.com/from-the-generic-reader.mp4')).toBeNull();

    // Once the render is there it is read, whatever the flag says.
    expect(readVeoJobsResultUrl({
      state: 'success',
      resultJson: JSON.stringify({
        data: {
          origin_urls: ['https://tempfile.example.com/veo-720p.mp4'],
          result_urls: ['https://tempfile.example.com/veo-4k.mp4'],
          high_resolution_pending: true,
        },
      }),
    })).toBe('https://tempfile.example.com/veo-4k.mp4');
    // And a record that says the render is not pending falls back to the original, as before.
    expect(readVeoJobsResultUrl({
      state: 'success',
      resultJson: JSON.stringify({
        data: { origin_urls: ['https://tempfile.example.com/veo-720p.mp4'], high_resolution_pending: false },
      }),
    })).toBe('https://tempfile.example.com/veo-720p.mp4');
  });

  it('takes the caller\'s fallback for a shape it does not read itself', () => {
    // The shared result reader (getFirstResultUrl) also knows `resultUrl`, `url` and a
    // bare list; the sync hands its answer in so a Veo row never loses a URL it found.
    const singular = { state: 'success', resultJson: JSON.stringify({ resultUrl: 'https://tempfile.example.com/singular.mp4' }) };
    expect(readVeoJobsResultUrl(singular)).toBeNull();
    expect(readVeoJobsResultUrl(singular, 'https://tempfile.example.com/singular.mp4'))
      .toBe('https://tempfile.example.com/singular.mp4');
    // A list the reader knows wins over the fallback, renders first.
    expect(readVeoJobsResultUrl({
      resultJson: JSON.stringify({ data: { result_urls: ['https://tempfile.example.com/4k.mp4'] } }),
    }, 'https://tempfile.example.com/other.mp4')).toBe('https://tempfile.example.com/4k.mp4');
  });

  it.each([
    ['no task', null],
    ['no result at all', { state: 'success' }],
    ['an empty result list', { state: 'success', resultJson: '{"resultUrls":[]}' }],
    ['malformed resultJson', { state: 'success', resultJson: '{broken' }],
    ['blank entries', { state: 'success', resultJson: '{"resultUrls":["", "  "]}' }],
    ['a failure', { state: 'fail', resultJson: '', failMsg: 'flagged' }],
  ])('finds nothing in %s', (_label, task) => {
    expect(readVeoJobsResultUrl(task)).toBeNull();
  });
});

describe('the Veo 3.1 price after the move', () => {
  // Kie's per-video credits for model veo-3-1 (kie.ai/veo-3-1 `pricingDesc`, read
  // 2026-10-20): "Lite mode … 720P — 30 credits … 1080P — 35 … 4K — 150", "Fast mode …
  // 60 … 65 … 180", "Quality mode … 250 … 255 … 370". The app charges the same
  // figures, and the move changes neither side.
  const KIE_CREDITS_PER_VIDEO = {
    veo3_lite: { '720p': 30, '1080p': 35, '4k': 150 },
    veo3_fast: { '720p': 60, '1080p': 65, '4k': 180 },
    veo3: { '720p': 250, '1080p': 255, '4k': 370 },
  } as const;
  const CASES = (Object.keys(KIE_CREDITS_PER_VIDEO) as Array<keyof typeof KIE_CREDITS_PER_VIDEO>)
    .flatMap((mode) => (['720p', '1080p', '4k'] as const).map((resolution) => ({
      mode,
      resolution,
      credits: KIE_CREDITS_PER_VIDEO[mode][resolution],
    })));

  function inputs(images: number): GenerationModelRuntimeInputs {
    return {
      counts: { images, videos: 0, audios: 0, preparedAudios: 0, characters: 0 },
      slotCounts: {},
      slotDurationsSeconds: {},
      referenceVideoDurationsSeconds: [],
    };
  }

  const codeConfig = buildCodeGenerationModelOperations().find((entry) => entry.modelId === 'veo-3.1');
  // The newest catalog release that carries Veo 3.1: production quotes from its entry once it is published.
  const releaseEntry = (JSON.parse(readFileSync(
    path.join(process.cwd(), 'config/generation-model-catalog/releases/2026-10-30-veo-quality-references.json'),
    'utf8',
  )) as { entries: Array<GenerationModelOperationalConfig> }).entries.find((entry) => entry.modelId === 'veo-3.1');

  it('keeps the providerModelMap the tiers are read from', () => {
    for (const config of [codeConfig, releaseEntry]) {
      expect(config?.providerModelMap).toEqual({
        default: 'veo3_fast',
        veo3_lite: 'veo3_lite',
        veo3_fast: 'veo3_fast',
        veo3: 'veo3',
      });
    }
  });

  it.each(CASES)('quotes $mode at $resolution at $credits credits, the tier Kie bills it at', ({ mode, resolution, credits }) => {
    expect(veoJobsTier(mode)).toBe(mode);
    expect(getVideoCost('veo-3.1', { mode, resolution, durationSeconds: 8 })).toBe(credits);
    for (const images of [0, 1]) {
      expect(calculateGenerationModelRuntimeCost(codeConfig!, { mode, resolution }, inputs(images))).toBe(credits);
      expect(calculateGenerationModelRuntimeCost(releaseEntry!, { mode, resolution }, inputs(images))).toBe(credits);
    }
  });
});

describe('readVeoJobsResultUrl on the record itself', () => {
  it('reads lists kept on the task record, renders before originals', () => {
    // As run live on 2026-10-20 (Lite 720p): the result under resultJson.resultUrls.
    expect(readVeoJobsResultUrl({ resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/a.mp4'] }) }))
      .toBe('https://tempfile.aiquickdraw.com/a.mp4');
    // The docs' 720p original on the record itself, with no other list.
    expect(readVeoJobsResultUrl({ state: 'success', origin_urls: ['https://tempfile.aiquickdraw.com/origin.mp4'] }))
      .toBe('https://tempfile.aiquickdraw.com/origin.mp4');
    // A render anywhere wins over an original anywhere, the record's own included.
    expect(readVeoJobsResultUrl({
      origin_urls: ['https://tempfile.aiquickdraw.com/origin.mp4'],
      resultJson: JSON.stringify({ data: { result_urls: ['https://tempfile.aiquickdraw.com/1080p.mp4'] } }),
    })).toBe('https://tempfile.aiquickdraw.com/1080p.mp4');
    expect(readVeoJobsResultUrl({ result_urls: ['https://tempfile.aiquickdraw.com/4k.mp4'], originUrls: ['https://tempfile.aiquickdraw.com/o.mp4'] }))
      .toBe('https://tempfile.aiquickdraw.com/4k.mp4');
  });
});
