import { describe, expect, it } from 'vitest';

import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import {
  providerImageFieldLimits,
  providerImageSizeViolation,
  providerRequestImages,
  type ProviderRequestImage,
} from '@/lib/provider-image-limits';

const MB = 1024 * 1024;

/**
 * Kie's documented size limit for every picture field the app fills, re-read on each
 * endpoint's docs.kie.ai/market/<page>.md on 2026-10-20: [field, megabytes, 'total' when
 * the limit is for the field's pictures together].
 */
const KIE_IMAGE_LIMITS: Record<string, Array<[string, number] | [string, number, 'total']>> = {
  'flux-2/pro-image-to-image': [['input_urls', 10]],
  'grok-imagine/image-to-image': [['image_urls', 10]],
  'grok-imagine/image-to-video': [['image_urls', 10]],
  'hailuo/2-3-image-to-video-standard': [['image_url', 10]],
  'hailuo/2-3-image-to-video-pro': [['image_url', 10]],
  'kling/v3-turbo-image-to-video': [['image_urls', 10]],
  'kling-3.0/video': [['kling_elements', 10]],
  'kling-2.6/motion-control': [['input_urls', 10]],
  'kling-3.0/motion-control': [['input_urls', 10]],
  'qwen3/image-to-image': [['image_urls', 10]],
  'qwen3/pro-image-to-image': [['image_urls', 10]],
  'ideogram/v3-remix': [['image_url', 10]],
  'ideogram/character': [['reference_image_urls', 10, 'total']],
  'gemini-omni-video': [['image_urls', 20]],
  'google/gemini-omni-flash-1-1': [['image_urls', 20]],
  'happyhorse-1-1/image-to-video': [['image_urls', 20]],
  'happyhorse-1-1/reference-to-video': [['reference_image', 20]],
  'grok-imagine-video-1-5-preview': [['image_urls', 20]],
  'pixverse-v6/image-to-video': [['image_urls', 20]],
  'pixverse-v6/transition': [['first_frame_image_url', 20], ['last_frame_image_url', 20]],
  'wan/3-0-video': [['first_frame_url', 20], ['last_frame_url', 20], ['reference_image_urls', 20]],
  'wan/3-0-video-prime': [['first_frame_url', 20], ['last_frame_url', 20], ['reference_image_urls', 20]],
  'nano-banana-2': [['image_input', 30]],
  'nano-banana-2-lite': [['image_urls', 30]],
  'nano-banana-pro': [['image_input', 30]],
  'seedream/5-pro-image-to-image': [['image_urls', 30]],
  'seedream/5-lite-image-to-image': [['image_urls', 30]],
  'seedream/5-flash-image-to-image': [['image_urls', 30]],
  // Delisted on Kie's site; the last captured page's input_urls limit (provider-image-limits).
  'bytedance/seedance-1.5-pro': [['input_urls', 10]],
  'bytedance/seedance-2': [['reference_image_urls', 30]],
  'bytedance/seedance-2-fast': [['reference_image_urls', 30]],
  'bytedance/seedance-2-mini': [['reference_image_urls', 30]],
  'bytedance/seedance-2-5': [['reference_image_urls', 30]],
  'minimax-h3/image-to-video': [['first_frame_url', 30], ['last_frame_url', 30]],
  'minimax-h3/reference-to-video': [['reference_image_urls', 30]],
  'qwen2-1/image-to-image': [['image_urls', 30]],
  'kling-3.0-omni/image-to-video': [['image_urls', 50]],
  'kling-3.0-omni/reference-to-video': [['image_urls', 50]],
};

/**
 * Endpoints the app sends pictures to whose pages document no size for them that day:
 * wan/2-7-r2v's "up to 30MB" is its reference voice, and pixverse-v6/reference-to-video,
 * the GPT Image pages, Wan 2.7's frame and image pages and Veo name none. Seedance 1.5
 * Pro's page is gone (404); its last captured page's 10 MB is used (provider-image-limits).
 */
const NO_DOCUMENTED_IMAGE_LIMIT = new Set([
  'wan/2-7-r2v',
  'wan/2-7-image-to-video',
  'wan/2-7-image',
  'wan/2-7-image-pro',
  'pixverse-v6/reference-to-video',
  'gpt-image-2-image-to-image',
  'gpt-image-2-5-flare-image-to-image',
  'gpt-image-2-5-sunburst-image-to-image',
  'veo3',
  'veo3_fast',
  'veo3_lite',
  'z-image',
  'google/imagen4',
  'google/imagen4-fast',
  'google/imagen4-ultra',
]);

function measured(images: ProviderRequestImage[], sizes: Array<number | null>) {
  return images.map((image, index) => ({ ...image, sizeBytes: sizes[index] ?? null }));
}

function violation(modelId: string, request: unknown, sizes: Array<number | null>) {
  return providerImageSizeViolation(modelId, measured(providerRequestImages(request), sizes));
}

describe('provider image limits', () => {
  it('holds each picture field to the size Kie documents for it', () => {
    const table = Object.fromEntries(Object.keys(KIE_IMAGE_LIMITS).map((providerModelId) => [
      providerModelId,
      providerImageFieldLimits(providerModelId).map((limit) => (
        limit.total ? [limit.field, limit.maxMegabytes, 'total'] : [limit.field, limit.maxMegabytes]
      )),
    ]));

    expect(table).toEqual(KIE_IMAGE_LIMITS);
  });

  it('decides every provider endpoint the app sends runs to', () => {
    const providerModelIds = new Set(buildCodeGenerationModelOperations().flatMap((operation) => (
      Object.values(operation.providerModelMap)
    )));
    const undecided = [...providerModelIds].filter((providerModelId) => (
      !Object.hasOwn(KIE_IMAGE_LIMITS, providerModelId)
      && !NO_DOCUMENTED_IMAGE_LIMIT.has(providerModelId)
      // A text endpoint is sent no pictures.
      && !/text-to-(?:image|video)$/.test(providerModelId)
      && !providerModelId.startsWith('elevenlabs/')
    ));

    expect(undecided).toEqual([]);
    for (const providerModelId of NO_DOCUMENTED_IMAGE_LIMIT) {
      expect(providerImageFieldLimits(providerModelId), providerModelId).toEqual([]);
    }
  });

  it('names the model, its limit and the picture over it', () => {
    const request = {
      model: 'qwen3/image-to-image',
      input: { prompt: 'Swap the label', image_urls: ['https://cdn/a.png', 'https://cdn/b.png'] },
    };

    expect(violation('qwen3', request, [4 * MB, 13_002_342]))
      .toBe('Qwen Image 3.0 takes reference images up to 10 MB; Reference 2 is 12.4 MB.');
  });

  it('accepts a picture at the limit and flags one a byte over it', () => {
    const request = { model: 'flux-2/pro-image-to-image', input: { input_urls: ['https://cdn/a.png'] } };

    expect(violation('flux-2-pro', request, [10 * MB])).toBeNull();
    // Rounded up, so a picture over its limit never reads as within it.
    expect(violation('flux-2-pro', request, [10 * MB + 1]))
      .toBe('FLUX.2 Pro takes reference images up to 10 MB; Reference 1 is 10.1 MB.');
  });

  it('allows a picture whose size is unknown', () => {
    const request = { model: 'qwen3/image-to-image', input: { image_urls: ['https://cdn/a.png', 'asset://asset-1'] } };

    expect(violation('qwen3', request, [null, null])).toBeNull();
    expect(violation('qwen3', request, [null, 9 * MB])).toBeNull();
  });

  it('holds Ideogram Character’s references to 10 MB together', () => {
    const request = {
      model: 'ideogram/character',
      input: { reference_image_urls: ['https://cdn/a.png', 'https://cdn/b.png'] },
    };

    expect(violation('ideogram-character', request, [6 * MB, 4 * MB])).toBeNull();
    expect(violation('ideogram-character', request, [6 * MB, 5 * MB]))
      .toBe('Ideogram Character takes up to 10 MB of reference images in total; yours come to 11.0 MB.');
    // What is known already passes the limit, so the picture of unknown size cannot help.
    expect(violation('ideogram-character', request, [11 * MB, null]))
      .toBe('Ideogram Character takes up to 10 MB of reference images in total; yours come to 11.0 MB.');
    expect(violation('ideogram-character', request, [9 * MB, null])).toBeNull();
  });

  it('leaves a model whose endpoint has no documented limit alone', () => {
    expect(providerRequestImages({
      model: 'gpt-image-2-image-to-image',
      input: { input_urls: ['https://cdn/a.png'] },
    })).toEqual([]);
    // Its 30 MB is the reference voice's.
    expect(providerRequestImages({
      model: 'wan/2-7-r2v',
      input: { reference_image: ['https://cdn/a.png'], reference_voice: 'https://cdn/v.mp3' },
    })).toEqual([]);
    // Veo's body carries its pictures at the top level, and Veo documents no size.
    expect(providerRequestImages({ model: 'veo3_fast', imageUrls: ['https://cdn/a.png'] })).toEqual([]);
    expect(providerRequestImages(null)).toEqual([]);
    expect(providerRequestImages({ model: 'qwen3/image-to-image' })).toEqual([]);
    expect(providerRequestImages({ input: { image_urls: ['https://cdn/a.png'] } })).toEqual([]);
  });

  it('measures only the fields its limits name, and only links', () => {
    expect(providerRequestImages({
      model: 'bytedance/seedance-2',
      input: {
        // Seedance documents no size for its frames.
        first_frame_url: 'https://cdn/start.png',
        reference_image_urls: ['https://cdn/a.png', 42, '', 'https://cdn/b.png'],
        reference_video_urls: ['https://cdn/clip.mp4'],
      },
    }).map(({ url, label }) => [url, label])).toEqual([
      ['https://cdn/a.png', 'Reference 1'],
      ['https://cdn/b.png', 'Reference 2'],
    ]);
  });

  it('names frames, a character image and a model’s mixed pictures the way the creator knows them', () => {
    expect(violation('hailuo-2.3', {
      model: 'hailuo/2-3-image-to-video-pro',
      input: { image_url: 'https://cdn/start.png' },
    }, [12 * MB])).toBe('Hailuo 2.3 takes frames up to 10 MB; the start frame is 12.0 MB.');
    expect(violation('kling-3.0-turbo', {
      model: 'kling/v3-turbo-image-to-video',
      input: { image_urls: ['https://cdn/start.png'] },
    }, [10.5 * MB])).toBe('Kling 3 Turbo takes frames up to 10 MB; the start frame is 10.5 MB.');
    expect(violation('minimax-h3', {
      model: 'minimax-h3/image-to-video',
      input: { first_frame_url: 'https://cdn/start.png', last_frame_url: 'https://cdn/end.png' },
    }, [3 * MB, 31 * MB])).toBe('MiniMax H3 takes frames up to 30 MB; the end frame is 31.0 MB.');
    expect(violation('pixverse-v6', {
      model: 'pixverse-v6/transition',
      input: { first_frame_image_url: 'https://cdn/start.png', last_frame_image_url: 'https://cdn/end.png' },
    }, [21 * MB, 1 * MB])).toBe('PixVerse V6 takes frames up to 20 MB; the start frame is 21.0 MB.');
    expect(violation('kling-o3', {
      model: 'kling-3.0-omni/image-to-video',
      input: { image_urls: ['https://cdn/start.png', 'https://cdn/end.png'] },
    }, [1 * MB, 51 * MB])).toBe('Kling O3 takes frames up to 50 MB; the end frame is 51.0 MB.');
    expect(violation('kling-2.6', {
      model: 'kling-2.6/motion-control',
      input: { input_urls: ['https://cdn/hero.png'], video_urls: ['https://cdn/dance.mp4'] },
    }, [Math.floor(12.4 * MB)])).toBe('Kling 2.6 takes character images up to 10 MB; the character image is 12.4 MB.');
    // Grok's pictures are its references or its start frame.
    expect(violation('grok-imagine-video', {
      model: 'grok-imagine/image-to-video',
      input: { image_urls: ['https://cdn/a.png'] },
    }, [11 * MB])).toBe('Grok Imagine Video takes images up to 10 MB; Image 1 is 11.0 MB.');
    // Seedance 1.5 Pro's input_urls carry its reference pictures or its frames.
    expect(violation('seedance-1.5-pro', {
      model: 'bytedance/seedance-1.5-pro',
      input: { input_urls: ['https://cdn/a.png', 'https://cdn/b.png'] },
    }, [1 * MB, 11 * MB])).toBe('Seedance 1.5 Pro takes images up to 10 MB; Image 2 is 11.0 MB.');
    expect(violation('wan-3.0', {
      model: 'wan/3-0-video',
      input: { reference_image_urls: ['https://cdn/a.png', 'https://cdn/b.png'] },
    }, [1 * MB, 20 * MB + 1])).toBe('Wan 3.0 takes reference images up to 20 MB; Reference 2 is 20.1 MB.');
  });

  it('measures the pictures of a Kling 3.0 image element, not a video element’s clip', () => {
    const request = {
      model: 'kling-3.0/video',
      input: {
        prompt: '@dog chases @cat',
        kling_elements: [
          { name: 'dog', description: 'Dog', element_input_urls: ['https://cdn/dog.mp4'] },
          { name: 'cat', description: 'Cat', element_input_urls: ['https://cdn/cat-1.png', 'https://cdn/cat-2.png'] },
        ],
      },
    };

    expect(providerRequestImages(request).map(({ url, label }) => [url, label])).toEqual([
      ['https://cdn/cat-1.png', 'image 1 of @cat'],
      ['https://cdn/cat-2.png', 'image 2 of @cat'],
    ]);
    expect(violation('kling-3.0-video', request, [2 * MB, 11 * MB]))
      .toBe('Kling 3.0 Cinematic takes element images up to 10 MB; image 2 of @cat is 11.0 MB.');
  });

  it('names a model the app does not list by its id', () => {
    expect(violation('remotely-published-model', {
      model: 'qwen3/image-to-image',
      input: { image_urls: ['https://cdn/a.png'] },
    }, [11 * MB])).toBe('remotely-published-model takes reference images up to 10 MB; Reference 1 is 11.0 MB.');
  });
});
