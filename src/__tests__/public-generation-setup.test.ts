import { beforeAll, describe, expect, it, vi } from 'vitest';

const logBackendErrorMock = vi.hoisted(() => vi.fn());
const logBackendWarningMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (...args: unknown[]) => logBackendErrorMock(...args),
  logBackendWarning: (...args: unknown[]) => logBackendWarningMock(...args),
}));

const storeState = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock('@/lib/generation-model-catalog-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/generation-model-catalog-store')>();
  return {
    ...original,
    loadPublishedGenerationModelCatalog: vi.fn(async (...args: Parameters<typeof original.loadPublishedGenerationModelCatalog>) => {
      if (storeState.failure) throw storeState.failure;
      return original.loadPublishedGenerationModelCatalog(...args);
    }),
  };
});

import { GENERATION_MODEL_CATALOG_SCHEMA_VERSION, buildGenerationModelCatalog, type GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import { loadPublishedGenerationModelCatalog } from '@/lib/generation-model-catalog-store';
import {
  PUBLIC_GENERATION_SETUP_COLUMNS,
  PUBLIC_GENERATION_SETUP_PATHS,
  buildPublicGenerationSetup,
  loadPublicGenerationSetupCatalog,
  publicPostGenerationSetup,
  readPublicGenerationSetupRow,
  selectWithGenerationSetup,
  toPublicGenerationSetupCatalog,
  type PublicGenerationSetupCatalog,
  type PublicGenerationSetupRow,
} from '@/lib/public-generation-setup';
import mobileApiContract from '../../contracts/mobile-api-v1.json';
import creationPost from '../../tests/e2e/fixtures/creation-post.json';
import { formatGenerationSetupLine } from '../../ugc-mobile/lib/generation-setup/generation-setup';
import { postgrestSelect } from './fixtures/postgrest-select';

/**
 * A creation's settings are a standard detail of its post, seen without unlocking anything
 * (owner, 2026-11-03), and the line names only what the creator chose (#675's review): a
 * setting shows where the run's model, as the published catalog lists it, offered a choice for
 * it in that run, with the value the run stored. The catalog here is the code catalog, which the
 * tests' environment publishes, as the starts read it.
 */
let catalog: PublicGenerationSetupCatalog;
beforeAll(async () => {
  catalog = (await loadPublicGenerationSetupCatalog())!;
});

/** A stored creation row: its category and creation mode ride along as stored, unread (the model's kind decides). */
type StoredRow = PublicGenerationSetupRow & { category?: string | null; creation_mode?: string | null };

function setup(row: StoredRow, from: PublicGenerationSetupCatalog = catalog) {
  return buildPublicGenerationSetup(row, from);
}

function line(row: StoredRow) {
  return formatGenerationSetupLine(setup(row));
}

const frame = (name: string) => ({ kind: 'image', storagePath: `uploads/user-1/${name}.png` });

describe('the settings a creation post shows everyone', () => {
  it("shows an image run's aspect ratio, resolution and output format where its model offers each", () => {
    const entries = setup({
      category: 'image',
      model: 'nano-banana-2',
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        resolution: '1K',
        outputFormat: 'jpg',
        googleSearch: false,
        elements: [{ id: 'element-1', displayName: 'Bottle', handle: '@bottle', storagePath: 'uploads/user-1/bottle.png' }],
      },
    });

    expect(entries).toEqual([
      { label: 'Aspect ratio', value: '9:16' },
      { label: 'Resolution', value: '1K' },
      { label: 'Output format', value: 'JPG' },
    ]);
    expect(formatGenerationSetupLine(entries)).toBe('9:16 · 1K · JPG');
    // Made with names the model; the recipe's preview counts the references.
    expect(JSON.stringify(entries)).not.toMatch(/model|nano|banana|input|reference|@bottle|grounding/i);
  });

  // The start stores the catalog's defaults for what a model does not take (`outputFormat: 'jpg'`,
  // `googleSearch: false`): GPT Image is sent no format, and its picture comes back a PNG.
  it('names no format, and no resolution, a model never offered', () => {
    expect(line({
      category: 'image',
      model: 'gpt-image-2',
      workflow_settings: { model: 'gpt-image-2', aspectRatio: '16:9', resolution: '2K', outputFormat: 'jpg', googleSearch: false },
    })).toBe('16:9 · 2K');
    // One resolution on the model, one format the start fills in: the ratio alone was chosen.
    expect(setup({
      category: 'image',
      model: 'nano-banana-2-lite',
      workflow_settings: { model: 'nano-banana-2-lite', aspectRatio: '3:4', resolution: '1K', outputFormat: 'jpg', googleSearch: false },
    })).toEqual([{ label: 'Aspect ratio', value: '3:4' }]);
  });

  // GPT Image 2 renders its automatic ratio at 1K only (its quote's option rule): a run at auto
  // was offered one resolution, a square one two.
  it('reads the options a model offered at the ratio the run chose', () => {
    const gpt = (aspectRatio: string, resolution: string) => setup({
      category: 'image',
      model: 'gpt-image-2',
      workflow_settings: { aspectRatio, resolution, outputFormat: 'jpg' },
    });
    expect(gpt('auto', '1K')).toEqual([{ label: 'Aspect ratio', value: 'Auto' }]);
    expect(formatGenerationSetupLine(gpt('auto', '1K'))).toBe('Auto ratio');
    expect(gpt('1:1', '2K')).toEqual([{ label: 'Aspect ratio', value: '1:1' }, { label: 'Resolution', value: '2K' }]);
  });

  it("shows an image model's quality or speed beside its resolution, under the model's own name for it", () => {
    expect(setup({
      category: 'image',
      model: 'grok-imagine-image',
      workflow_settings: { model: 'grok-imagine-image', aspectRatio: '2:3', resolution: '1K', qualityMode: 'quality', outputFormat: 'jpg' },
    })).toEqual([
      { label: 'Aspect ratio', value: '2:3' },
      { label: 'Quality', value: 'Quality' },
    ]);
    expect(setup({
      category: 'image',
      model: 'ideogram-v3',
      workflow_settings: { model: 'ideogram-v3', aspectRatio: '1:1', resolution: '1K', qualityMode: 'turbo', outputFormat: 'jpg' },
    })).toEqual([
      { label: 'Aspect ratio', value: '1:1' },
      { label: 'Speed', value: 'Turbo' },
    ]);
  });

  // startImageGeneration's Grok Imagine edit sends the picture alone: no ratio, no quality.
  it('shows nothing a Grok Imagine edit never sent', () => {
    expect(setup({
      category: 'image',
      model: 'grok-imagine-image',
      workflow_settings: {
        model: 'grok-imagine-image',
        aspectRatio: '2:3',
        resolution: '1K',
        qualityMode: 'quality',
        elements: [{ id: 'reference-1', displayName: 'Cat', handle: '@cat', storagePath: 'uploads/user-1/cat.png' }],
      },
    })).toEqual([]);
  });

  // No image model offers Google Search grounding any more, and every run stores `false`: a model
  // that offers the switch names it where the run had it on, and none says it was off.
  it('names Google Search grounding only where the model offered it and the run had it on', () => {
    const nanoBanana = buildGenerationModelCatalog({ platform: 'web', schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION })
      .models.find((model) => model.id === 'nano-banana-2')!;
    const grounded: GenerationModelDescriptor = {
      ...nanoBanana,
      controls: [...nanoBanana.controls, { key: 'googleSearch', label: 'Google Search', type: 'boolean', presentation: 'toggle', defaultValue: false }],
    };
    const withGrounding = toPublicGenerationSetupCatalog({ catalog: { models: [grounded] }, operations: new Map() });
    const settings = { model: 'nano-banana-2', aspectRatio: '4:5', resolution: '2K', outputFormat: 'png' };

    const on = setup({ category: 'image', model: 'nano-banana-2', workflow_settings: { ...settings, googleSearch: true } }, withGrounding);
    expect(formatGenerationSetupLine(on)).toBe('4:5 · 2K · PNG · Search grounding on');
    for (const googleSearch of [false, undefined, 'true', null]) {
      expect(setup({ category: 'image', model: 'nano-banana-2', workflow_settings: { ...settings, googleSearch } }, withGrounding))
        .toEqual(on.slice(0, 3));
    }
    // Today's catalog offers it on no model, so a run that stored it on says nothing of it.
    expect(line({ category: 'image', model: 'nano-banana-2', workflow_settings: { ...settings, googleSearch: true } })).toBe('4:5 · 2K · PNG');
  });

  it("shows a video run's ratio, resolution, length and sound on a model with a sound switch, and none of its inputs", () => {
    const entries = setup({
      category: 'video',
      model: 'bytedance/seedance-2-fast',
      workflow_settings: {
        model: 'seedance-2-fast',
        aspectRatio: '16:9',
        duration: 12,
        resolution: '480p',
        mode: '',
        sound: true,
        fixedLens: false,
        referenceMode: 'elements',
        elements: [{ id: 'element-1', displayName: 'Hero', handle: '@hero', storagePath: 'uploads/user-1/hero.png' }],
        referenceVideoUrls: ['asset-video-1'],
        referenceAudioUrls: ['asset-audio-1'],
      },
    });

    expect(entries).toEqual([
      { label: 'Aspect ratio', value: '16:9' },
      { label: 'Resolution', value: '480P' },
      { label: 'Duration', value: '12s' },
      { label: 'Sound', value: 'On' },
    ]);
    expect(formatGenerationSetupLine(entries)).toBe('16:9 · 480P · 12s · Sound on');
    expect(JSON.stringify(entries)).not.toMatch(/seedance|model|input|reference|frame|prompt|@hero|asset-/i);
    expect(line({ category: 'video', model: 'seedance-2-fast', workflow_settings: { model: 'seedance-2-fast', aspectRatio: '9:16', duration: 5, resolution: '720p', sound: false } }))
      .toBe('9:16 · 720P · 5s · Sound off');
  });

  // The start stores `sound: false` for every model without the switch: Veo 3.1, Grok Imagine and
  // Gemini Omni clips carry their own audio, and the others say nothing of it.
  it.each([
    ['Veo 3.1', 'veo-3.1', { mode: 'veo3_fast', aspectRatio: '16:9', resolution: '1080p', duration: 8 }, '16:9 · Fast · 1080P'],
    ['Grok Imagine Video', 'grok-imagine-video', { mode: 'fun', aspectRatio: '16:9', resolution: '720p', duration: 10 }, '16:9 · Fun · 720P · 10s'],
    ['Gemini Omni', 'gemini-omni-video', { mode: '', aspectRatio: '9:16', resolution: '4k', duration: 8 }, '9:16 · 4K · 8s'],
    ['Hailuo 2.3', 'hailuo-2.3', { mode: 'pro', aspectRatio: 'Auto', resolution: '1080P', duration: 6 }, 'Pro · 1080P · 6s'],
    ['Kling 3.0 Turbo', 'kling-3.0-turbo', { mode: '', aspectRatio: '9:16', resolution: '720p', duration: 5 }, '9:16 · 720P · 5s'],
  ])('says nothing of sound on %s, which has no sound switch', (_name, model, settings, expected) => {
    expect(line({ category: 'video', model, workflow_settings: { model, ...settings, sound: false, fixedLens: false } })).toBe(expected);
  });

  // Veo's Lite, Fast and Quality, Hailuo's Standard and Pro and Grok's Normal and Fun are priced
  // choices of their own: the mode shows beside the resolution, in the catalog's words, and one
  // length offered (Veo's 8 s) is no choice.
  it("shows the video mode a model offered beside its resolution, in the catalog's words", () => {
    expect(setup({
      category: 'video',
      model: 'veo-3.1',
      workflow_settings: { model: 'veo-3.1', mode: 'veo3', aspectRatio: '9:16', resolution: '4k', duration: 8, sound: false },
    })).toEqual([
      { label: 'Aspect ratio', value: '9:16' },
      { label: 'Mode', value: 'Quality' },
      { label: 'Resolution', value: '4K' },
    ]);
    expect(line({
      category: 'video',
      model: 'kling-3.0-video',
      workflow_settings: { model: 'kling-3.0-video', aspectRatio: '9:16', mode: 'std', resolution: '', duration: 5, sound: false },
    })).toBe('9:16 · Standard (720p) · 5s · Sound off');
  });

  it("counts a multi-shot run's shots, from either start path, and leaves a lens that moves unsaid", () => {
    expect(line({
      category: 'video',
      model: 'kling-3.0-video',
      workflow_settings: {
        model: 'kling-3.0-video',
        aspectRatio: '16:9',
        mode: 'pro',
        duration: 12,
        sound: true,
        fixedLens: false,
        multiPrompts: [{ prompt: 'One', duration: 4 }, { prompt: 'Two', duration: 4 }, { prompt: 'Three', duration: 4 }],
      },
    })).toBe('16:9 · Pro (1080p, High Quality) · 12s · Sound on · 3 shots');
    expect(line({
      category: 'video',
      model: 'kling-o3',
      workflow_settings: { model: 'kling-o3', aspectRatio: '16:9', resolution: '1080p', duration: 10, sound: false, shots: [{ prompt: 'One' }, { prompt: 'Two' }] },
    })).toBe('16:9 · 1080P · 10s · Sound off · 2 shots');
    // A model with no multi-shot switch says nothing of shots, whatever the run stored.
    expect(line({
      category: 'video',
      model: 'seedance-2',
      workflow_settings: { model: 'seedance-2', aspectRatio: '16:9', resolution: '720p', duration: 5, sound: false, multiPrompts: [{ prompt: 'One' }, { prompt: 'Two' }] },
    })).toBe('16:9 · 720P · 5s · Sound off');
  });

  // A start frame gives an image-to-video clip its shape on these models: the request carries no
  // ratio (generation-services.test.ts holds each request to it), so the run shows none.
  describe('a clip whose start frame gave it its shape', () => {
    it.each([
      ['Kling 3.0 Turbo', 'kling-3.0-turbo', { startFrame: frame('start') }],
      ['MiniMax H3, from its end frame alone', 'minimax-h3', { endFrame: frame('end') }],
      ['Wan 2.7', 'wan-2.7', { startFrame: frame('start'), endFrame: frame('end') }],
      ['Wan 3.0', 'wan-3.0', { startFrame: frame('start') }],
      ['PixVerse V6, between two frames', 'pixverse-v6', { startFrame: frame('start'), endFrame: frame('end') }],
      ['HappyHorse 1.1', 'happyhorse-1.1', { startFrame: frame('start') }],
      ['Grok Imagine Video', 'grok-imagine-video', { startFrame: frame('start') }],
      ['Kling O3, in one shot', 'kling-o3', { startFrame: frame('start') }],
    ])('shows no ratio on %s', (_name, model, frames) => {
      const run = (extra: Record<string, unknown>) => setup({
        category: 'video',
        model,
        workflow_settings: { model, aspectRatio: '16:9', resolution: '720p', duration: 5, ...extra },
      });
      expect(run({ referenceMode: 'frames', ...frames }).map((entry) => entry.label)).not.toContain('Aspect ratio');
      // The same model from a prompt alone keeps the ratio it was sent.
      expect(run({ referenceMode: 'frames' })[0]).toEqual({ label: 'Aspect ratio', value: '16:9' });
    });

    it('keeps the ratio a request sent beside a frame', () => {
      const ratioOf = (model: string, settings: Record<string, unknown>) => setup({
        category: 'video',
        model,
        workflow_settings: { model, aspectRatio: '9:16', resolution: '720p', duration: 5, ...settings },
      })[0];
      // A Kling O3 multi-shot run sends its ratio with its frame.
      expect(ratioOf('kling-o3', { referenceMode: 'frames', startFrame: frame('start'), multiPrompts: [{ prompt: 'One' }, { prompt: 'Two' }] }))
        .toEqual({ label: 'Aspect ratio', value: '9:16' });
      // Wan 2.7's references run takes a start frame beside its references, and its ratio.
      expect(ratioOf('wan-2.7', { referenceMode: 'references', startFrame: frame('start'), referenceImageUrls: ['https://cdn.test/a.png'] }))
        .toEqual({ label: 'Aspect ratio', value: '9:16' });
      // Seedance 2 sends its ratio with its frames.
      expect(ratioOf('seedance-2', { referenceMode: 'frames', startFrame: frame('start'), sound: false }))
        .toEqual({ label: 'Aspect ratio', value: '9:16' });
    });

    it('reads Grok Imagine from its pictures: one sets the shape, several take the ratio', () => {
      const ratio = (model: string, settings: Record<string, unknown>) => setup({
        category: 'video',
        model,
        workflow_settings: { model, aspectRatio: '3:2', resolution: '480p', duration: 6, ...settings },
      }).some((entry) => entry.label === 'Aspect ratio');
      for (const model of ['grok-imagine-video', 'grok-imagine-video-1.5']) {
        expect(ratio(model, { referenceMode: 'references', referenceImageUrls: ['https://cdn.test/a.png'] })).toBe(false);
        expect(ratio(model, { referenceMode: 'references', referenceImageUrls: ['https://cdn.test/a.png', 'https://cdn.test/b.png'] })).toBe(true);
      }
      // 1.5 sends its start frame beside its pictures, and then no ratio.
      expect(ratio('grok-imagine-video-1.5', {
        referenceMode: 'references',
        startFrame: frame('start'),
        referenceImageUrls: ['https://cdn.test/a.png', 'https://cdn.test/b.png'],
      })).toBe(false);
    });
  });

  it("shows a motion run's length, render mode and character orientation, from either start path", () => {
    const legacy = setup({
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-2.6',
      workflow_settings: {
        creationMode: 'motion',
        model: 'kling-2.6',
        mode: '720p',
        duration: 8,
        characterOrientation: 'video',
        characterImage: { kind: 'image', storagePath: 'uploads/user-1/character.png' },
        referenceVideo: { kind: 'video', storagePath: 'uploads/user-1/reference.mp4' },
      },
    });
    expect(legacy).toEqual([
      { label: 'Duration', value: '8s' },
      { label: 'Render mode', value: '720P' },
      { label: 'Character orientation', value: 'Follow video' },
    ]);
    expect(formatGenerationSetupLine(legacy)).toBe('8s · 720P · Follow video');
    expect(JSON.stringify(legacy)).not.toMatch(/character image|reference video|uploads|kling/i);

    // A catalog-path motion run is a `video` marked by its creation mode, its render mode a `resolution`.
    expect(line({
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-3.0',
      workflow_settings: {
        model: 'kling-3.0',
        resolution: '1080p',
        duration: 10,
        characterOrientation: 'image',
        inputs: [{ slot: 'characterImage', kind: 'image', storagePath: 'uploads/user-1/character.png' }],
      },
    })).toBe('10s · 1080P · Favor image');
    // An older motion run kept the provider's id and no model of its own: the catalog knows it by that.
    expect(setup({
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-2.6/motion-control',
      workflow_settings: { creationMode: 'motion', mode: '1080p', duration: 5, characterOrientation: 'image' },
    })).toEqual([
      { label: 'Duration', value: '5s' },
      { label: 'Render mode', value: '1080P' },
      { label: 'Character orientation', value: 'Favor image' },
    ]);
  });

  // Accuracy over coverage: what a model the catalog no longer lists offered cannot be told.
  it('shows nothing for a run whose model the catalog no longer lists', () => {
    expect(setup({
      category: 'video',
      model: 'bytedance/seedance-1.5-pro',
      workflow_settings: { model: 'seedance-1.5-pro', aspectRatio: '16:9', resolution: '720p', duration: 8, sound: true, fixedLens: true },
    })).toEqual([]);
    expect(setup({ category: 'image', model: 'mystery-model', workflow_settings: { aspectRatio: '9:16' } })).toEqual([]);
  });

  // A template's settings and model are its author's, as its recipe is: Made with names no model
  // on its post, and the line shows nothing either.
  it.each([
    ['its run', { template_run_id: 'run-1', template_run_step_id: null }],
    ['its step', { template_run_id: null, template_run_step_id: 'step-1' }],
  ])('shows nothing of a template result that records %s', (_label, link) => {
    expect(setup({
      category: 'image',
      model: 'nano-banana-pro',
      workflow_settings: { aspectRatio: '9:16', resolution: '2K', outputFormat: 'png' },
      ...link,
    })).toEqual([]);
  });

  it('shows nothing without a creation, or a setting it did not store', () => {
    expect(setup(null as unknown as PublicGenerationSetupRow)).toEqual([]);
    expect(setup({ category: 'audio', model: 'eleven-v3', workflow_settings: { duration: 9 } })).toEqual([]);
    expect(setup({ category: 'image', model: 'nano-banana-2', workflow_settings: null })).toEqual([]);
    // A blank setting is left out rather than drawn as an empty value.
    expect(setup({ category: 'image', model: 'gpt-image-2', workflow_settings: { aspectRatio: ' ', resolution: '2K' } }))
      .toEqual([{ label: 'Resolution', value: '2K' }]);
  });

  it('builds the setup the shared contract pins for a post', () => {
    const pinned = mobileApiContract.endpoints.getShowcasePost.response.item.generationSetup;
    expect(setup({
      category: 'image',
      model: 'nano-banana-2',
      workflow_settings: { model: 'nano-banana-2', aspectRatio: '16:9', resolution: '1K', outputFormat: 'jpg', googleSearch: false },
    })).toEqual(pinned);
    expect(mobileApiContract.endpoints.getShowcasePost.responseVariants.templateResult.item.generationSetup).toEqual([]);
    expect(mobileApiContract.endpoints.getShowcaseFeed.response.items[0].generationSetup).toEqual(pinned);
  });
});

describe("a post's line, decided once for every read", () => {
  const built = [{ label: 'Aspect ratio', value: '9:16' }];

  it("carries the creation's line, and none for a written post or an upload", () => {
    expect(publicPostGenerationSetup({ postFormat: 'media', generationId: 'gen-1' }, built)).toEqual(built);
    expect(publicPostGenerationSetup({ postFormat: 'text', generationId: 'gen-1' }, built)).toEqual([]);
    expect(publicPostGenerationSetup({ postFormat: 'media', generationId: null }, undefined)).toEqual([]);
  });

  // [] is a post with none to show; a creation that could not be read is no answer at all, so a
  // client keeps nothing as none.
  it('leaves the line out where the creation could not be read', () => {
    expect(publicPostGenerationSetup({ postFormat: 'mixed', generationId: 'gen-1' }, undefined)).toBeUndefined();
  });
});

describe("reading a creation's settings for its post", () => {
  const stored = {
    model: 'bytedance/seedance-2-fast',
    category: 'video',
    creation_mode: null,
    template_run_id: null,
    template_run_step_id: null,
    workflow_settings: {
      model: 'seedance-2-fast',
      aspectRatio: '16:9',
      resolution: '480p',
      duration: 12,
      sound: true,
      fixedLens: false,
      referenceMode: 'frames',
      startFrame: frame('start'),
      compiledPrompt: 'A long prompt the line never needs',
      referenceImageUrls: ['https://cdn.test/a.png', 'https://cdn.test/b.png', 'https://cdn.test/c.png'],
      elements: [{ handle: '@a' }, { handle: '@b' }, { handle: '@c' }],
      outputs: [{ index: 0, storagePath: 'generated/out.mp4' }],
    },
  };

  it('selects the paths the line reads, never the whole record', () => {
    const select = `${PUBLIC_GENERATION_SETUP_COLUMNS}, ${PUBLIC_GENERATION_SETUP_PATHS}`;
    expect(select).toMatch(/workflow_settings->>aspectRatio/);
    // Every mention of the record is a path into it.
    expect(select.match(/workflow_settings(?!->)/g)).toBeNull();
    const answered = postgrestSelect(stored, select);
    expect(JSON.stringify(answered)).not.toMatch(/long prompt|generated\/out|c\.png|@c/);
  });

  it.each([
    ['an image run', { model: 'nano-banana-2', category: 'image', workflow_settings: { model: 'nano-banana-2', aspectRatio: '9:16', resolution: '2K', outputFormat: 'png', googleSearch: false } }],
    ['a Grok Imagine edit', { model: 'grok-imagine-image', category: 'image', workflow_settings: { model: 'grok-imagine-image', aspectRatio: '2:3', resolution: '1K', qualityMode: 'quality', elements: [{ handle: '@cat' }] } }],
    ['a video run from a frame', stored],
    ['a Grok Imagine clip from one picture', { model: 'grok-imagine-video-1.5', category: 'video', workflow_settings: { model: 'grok-imagine-video-1.5', aspectRatio: '3:2', resolution: '480p', duration: 6, referenceMode: 'references', referenceImageUrls: ['https://cdn.test/a.png'] } }],
    ['a multi-shot run', { model: 'kling-3.0/video', category: 'video', workflow_settings: { model: 'kling-3.0-video', aspectRatio: '16:9', mode: 'std', duration: 9, sound: false, multiPrompts: [{ prompt: 'One' }, { prompt: 'Two' }, { prompt: 'Three' }] } }],
    ['a motion run', { model: 'kling-2.6/motion-control', category: 'video', creation_mode: 'motion', workflow_settings: { creationMode: 'motion', mode: '720p', duration: 8, characterOrientation: 'video' } }],
    ['a template result', { model: 'nano-banana-pro', category: 'image', template_run_id: 'run-1', workflow_settings: { aspectRatio: '9:16', resolution: '2K' } }],
  ])('builds from the narrow read what it builds from the whole record: %s', (_name, row) => {
    const answered = postgrestSelect(row, `${PUBLIC_GENERATION_SETUP_COLUMNS}, ${PUBLIC_GENERATION_SETUP_PATHS}`);
    expect(setup(readPublicGenerationSetupRow(answered))).toEqual(setup(row as PublicGenerationSetupRow));
  });

  // The E2E server answers the post page's read with this row whatever it selects: it is the
  // narrow read's answer, so a path added or renamed here must be answered there too.
  it("keeps the E2E post fixture's creation in the shape the read selects", () => {
    const select = `${PUBLIC_GENERATION_SETUP_COLUMNS}, ${PUBLIC_GENERATION_SETUP_PATHS}`;
    expect(Object.keys(creationPost.generation).sort()).toEqual(Object.keys(postgrestSelect({}, select)).sort());
    expect(formatGenerationSetupLine(setup(readPublicGenerationSetupRow(creationPost.generation)))).toBe('9:16 · 1K · JPG');
  });

  it('reads with the paths, and again without them if the database refuses their shape', async () => {
    const selects: string[] = [];
    const read = (answers: Array<{ data: unknown; error: unknown }>) => (select: string) => {
      selects.push(select);
      return Promise.resolve(answers[selects.length - 1]!);
    };

    await expect(selectWithGenerationSetup('id, model', read([{ data: [{ id: 'gen-1' }], error: null }])))
      .resolves.toEqual({ data: [{ id: 'gen-1' }], error: null, withSetup: true });
    expect(selects).toEqual([`id, model, ${PUBLIC_GENERATION_SETUP_PATHS}`]);

    selects.length = 0;
    logBackendWarningMock.mockClear();
    const refused = { code: 'PGRST100', message: 'failed to parse select parameter' };
    await expect(selectWithGenerationSetup('id, model', read([{ data: null, error: refused }, { data: [{ id: 'gen-1' }], error: null }])))
      .resolves.toEqual({ data: [{ id: 'gen-1' }], error: null, withSetup: false });
    expect(selects).toEqual([`id, model, ${PUBLIC_GENERATION_SETUP_PATHS}`, 'id, model']);
    expect(logBackendWarningMock).toHaveBeenCalledWith('public_generation_setup_paths_refused', { error: refused });

    // Any other failure is the read's own: it is not asked twice.
    selects.length = 0;
    const timeout = { code: '57014', message: 'canceling statement due to statement timeout' };
    await expect(selectWithGenerationSetup('id, model', read([{ data: null, error: timeout }])))
      .resolves.toEqual({ data: null, error: timeout, withSetup: true });
    expect(selects).toHaveLength(1);
  });

  it('reads the published catalog the starts resolve, and no line at all when it cannot', async () => {
    expect(catalog.models.get('veo-3.1')?.descriptor.kind).toBe('video');
    expect(loadPublishedGenerationModelCatalog).toHaveBeenCalledWith({ platform: 'web', schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION });

    storeState.failure = new Error('release unavailable');
    logBackendErrorMock.mockClear();
    try {
      await expect(loadPublicGenerationSetupCatalog()).resolves.toBeNull();
    } finally {
      storeState.failure = null;
    }
    expect(logBackendErrorMock).toHaveBeenCalledWith('failed_to_load_public_generation_setup_catalog', { error: expect.any(Error) });
  });
});
