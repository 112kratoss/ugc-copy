import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * Release 2026-11-14-kie-models: Seedream 5.5 and GPT Image 2.6 (images), Kling 4.0 Flash and
 * Gemini Omni 1.2 Flash (videos) join the catalog (evidence: docs/model-api-references/
 * seedream-5-5.md, gpt-image-2-6.md, kling-4-0-flash.md, gemini-omni-1-2-flash.md, read
 * 2026-11-14). Every entry must equal the code build byte for byte, since the shadow verifier
 * diffs projections, so entries are compared against buildGenerationModelCatalog and
 * buildCodeGenerationModelOperations, while provider ids, prices and each spec's catches are
 * pinned to the evidence files.
 */

interface ManifestEntry {
  modelId: string;
  kind: string;
  webEnabled: boolean;
  mobileEnabled: boolean;
  adapterKey: string;
  adapterConfig: Record<string, unknown>;
  providerModelMap: Record<string, string>;
  pricingStrategy: string;
  pricingConfig: Record<string, unknown>;
  validationStrategy: string;
  validationConfig: Record<string, unknown>;
  publicDescriptor: Record<string, unknown>;
}

interface Manifest {
  mode: string;
  release: { revision: string; basedOnRevision: string; schemaVersion: number };
  expectedModelIds: string[];
  addsModelIds?: string[];
  entries: ManifestEntry[];
}

function read(name: string): Manifest {
  return JSON.parse(fs.readFileSync(path.resolve(
    process.cwd(),
    `config/generation-model-catalog/releases/${name}`,
  ), 'utf8')) as Manifest;
}

const manifest = read('2026-11-14-kie-models.json');
const base = read('2026-11-05-kie-models.json');

const ADDED = ['seedream-5.5', 'gpt-image-2.6', 'kling-4.0-flash', 'gemini-omni-1.2-flash'];
const IMAGES = ['seedream-5.5', 'gpt-image-2.6'];
const VIDEOS = ['kling-4.0-flash', 'gemini-omni-1.2-flash'];

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const mobileCatalog = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 2 });
const operations = new Map(
  buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]),
);

function entryFor(modelId: string): ManifestEntry {
  const entry = manifest.entries.find((candidate) => candidate.modelId === modelId);
  if (!entry) throw new Error(`no manifest entry for ${modelId}`);
  return entry;
}

function descriptor(modelId: string) {
  const found = catalog.models.find((model) => model.id === modelId);
  if (!found) throw new Error(`no descriptor for ${modelId}`);
  return found;
}

function options(modelId: string, key: string): string[] {
  const control = descriptor(modelId).controls.find((candidate) => candidate.key === key);
  return control?.type === 'choice' ? control.options.map((option) => option.value) : [];
}

function imageQuote(modelId: string, settings: Record<string, string>, images = 0): GenerationModelQuoteInput {
  return {
    kind: 'image',
    modelId,
    settings,
    inputCounts: { images, videos: 0, audios: 0 },
    inputMetadata: { slots: images > 0 ? { imageReferences: { count: images } } : {} },
    catalogRevision: catalog.revision,
  };
}

/** A video run with the slots it fills named, as both creators quote. */
function videoQuote(
  modelId: string,
  settings: Record<string, string | number | boolean>,
  slots: { startFrame?: number; endFrame?: number; imageReferences?: number } = {},
): GenerationModelQuoteInput {
  const named = Object.fromEntries(Object.entries(slots).filter(([, count]) => count > 0));
  const images = Object.values(named).reduce((total, count) => total + count, 0);
  return {
    kind: 'video',
    modelId,
    settings,
    inputCounts: { images, videos: 0, audios: 0 },
    inputMetadata: { slots: Object.fromEntries(Object.entries(named).map(([key, count]) => [key, { count }])) },
    catalogRevision: catalog.revision,
  };
}

function credits(input: GenerationModelQuoteInput): number {
  return quoteGenerationModel(input, { catalog }).costCredits;
}

/** The field errors a refused quote carries, which both creators show beside the field. */
function refusal(input: GenerationModelQuoteInput): unknown {
  try {
    quoteGenerationModel(input, { catalog });
  } catch (error) {
    return (error as { fieldErrors?: unknown }).fieldErrors;
  }
  throw new Error('the quote was not refused');
}

describe('kie-models-20261114 release', () => {
  it('chains onto the release production is running', () => {
    expect(manifest.release.revision).toBe('kie-models-20261114');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(base.release.revision).toBe('kie-models-20261105');
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
  });

  it('adds the four models and replaces no existing model', () => {
    expect(manifest.entries.map((entry) => entry.modelId).sort()).toEqual([...ADDED].sort());
    expect([...(manifest.addsModelIds ?? [])].sort()).toEqual([...ADDED].sort());
    // expectedModelIds guards the release being cloned: production's inventory.
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    expect(manifest.expectedModelIds).toHaveLength(50);
    for (const added of ADDED) expect(manifest.expectedModelIds).not.toContain(added);
  });

  it.each(ADDED)('%s: the manifest entry is the code build', (modelId) => {
    const entry = entryFor(modelId);
    const { schemaVersion, ...publicDescriptor } = entry.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(descriptor(modelId));
    const operation = operations.get(modelId)!;
    expect(entry.kind).toBe(IMAGES.includes(modelId) ? 'image' : 'video');
    expect(entry.adapterKey).toBe(operation.adapterKey);
    expect(entry.adapterConfig).toEqual(operation.adapterConfig);
    expect(entry.providerModelMap).toEqual(operation.providerModelMap);
    expect(entry.pricingStrategy).toBe(operation.pricingStrategy);
    expect(entry.pricingConfig).toEqual(operation.pricingConfig);
    expect(entry.validationStrategy).toBe(operation.validationStrategy);
    const { passthroughSettingKeys, ...validationConfig } = operation.validationConfig as Record<string, unknown>;
    expect(entry.validationConfig).toEqual(
      Array.isArray(passthroughSettingKeys) && passthroughSettingKeys.length > 0
        ? { ...validationConfig, passthroughSettingKeys }
        : validationConfig,
    );
  });

  it('routes each model to the provider ids its spec declares', () => {
    // Images on the declarative adapter, videos on the legacy one (video-v1 until a video
    // dispatch seam exists).
    expect(entryFor('seedream-5.5')).toMatchObject({
      adapterKey: 'kie-task-v1',
      providerModelMap: { text: 'seedream/5-5-text-to-image', reference: 'seedream/5-5-image-to-image' },
    });
    // Economy is the only 2.6 tier priced per picture; Flare and Sunburst bill tokens.
    expect(entryFor('gpt-image-2.6')).toMatchObject({
      adapterKey: 'kie-task-v1',
      providerModelMap: { text: 'gpt-image-2-6/economy-text-to-image', reference: 'gpt-image-2-6/economy-image-to-image' },
    });
    // Economy's schema refuses a field it does not name, and it names no resolution.
    expect(JSON.stringify(entryFor('gpt-image-2.6').adapterConfig)).not.toContain('"resolution"');
    expect(entryFor('kling-4.0-flash').providerModelMap).toEqual({
      default: 'kling-4.0/flash-reference-to-video',
      text: 'kling-4.0/flash-reference-to-video',
      image: 'kling-4.0/flash-keyframe-to-video',
      reference: 'kling-4.0/flash-reference-to-video',
    });
    expect(entryFor('gemini-omni-1.2-flash').providerModelMap).toEqual({ default: 'google/gemini-omni-flash-1-2' });
    for (const modelId of VIDEOS) expect(entryFor(modelId).adapterKey, modelId).toBe('video-v1');
    for (const modelId of ADDED) {
      expect(entryFor(modelId).validationStrategy, modelId).toBe('descriptor-rules-v1');
      expect(entryFor(modelId).webEnabled, modelId).toBe(true);
    }
  });

  it('turns every model on for mobile too: their makers are already named in the AI-data question', () => {
    for (const modelId of ADDED) {
      expect(entryFor(modelId).mobileEnabled, modelId).toBe(true);
      expect(mobileCatalog.models.map((model) => model.id), modelId).toContain(modelId);
    }
  });

  it('stays readable by every shipped app and sorts after the models that preceded it', () => {
    for (const modelId of ADDED) {
      const kind = IMAGES.includes(modelId) ? 'image' : 'video';
      const existingSortOrders = catalog.models
        .filter((model) => model.kind === kind && manifest.expectedModelIds.includes(model.id))
        .map((model) => model.sortOrder);
      const published = entryFor(modelId).publicDescriptor as {
        minClientSchemaVersion: number;
        sortOrder: number;
        controls: Array<{ key: string; type: string }>;
        inputModes: Array<{ key: string; slots: Array<{ kind: string; role: string }> }>;
      };
      expect(published.minClientSchemaVersion, modelId).toBe(1);
      expect(published.sortOrder, modelId).toBeGreaterThan(Math.max(...existingSortOrders));
      // Existing control types, mode keys, slot kinds and roles only: both creators render
      // only what the shared lists name, and mobile's parser fails closed on anything else.
      for (const control of published.controls) expect(['choice', 'integer', 'boolean'], `${modelId} ${control.key}`).toContain(control.type);
      for (const mode of published.inputModes) {
        expect(['frames', 'references'], `${modelId} ${mode.key}`).toContain(mode.key);
        for (const slot of mode.slots) {
          expect(['image'], `${modelId} ${mode.key}`).toContain(slot.kind);
          expect(['reference', 'startFrame', 'endFrame'], `${modelId} ${mode.key}`).toContain(slot.role);
        }
      }
    }
  });

  it('quotes Seedream 5.5 at 3.6 / 6.3 plus 1.44 for every input picture, rounded up', () => {
    // docs/model-api-references/seedream-5-5.md: the page's own example, a 2K edit of two
    // pictures, is 9.18, charged 10.
    expect(options('seedream-5.5', 'resolution')).toEqual(['1K', '2K']);
    expect(options('seedream-5.5', 'outputFormat')).toEqual(['jpg', 'png']);
    expect(options('seedream-5.5', 'aspectRatio')).toEqual(['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9']);
    expect(credits(imageQuote('seedream-5.5', { aspectRatio: '1:1', resolution: '1K' }))).toBe(4);
    expect(credits(imageQuote('seedream-5.5', { aspectRatio: '1:1', resolution: '2K' }))).toBe(7);
    expect(credits(imageQuote('seedream-5.5', { aspectRatio: '16:9', resolution: '1K' }, 1))).toBe(6);
    expect(credits(imageQuote('seedream-5.5', { aspectRatio: '16:9', resolution: '2K' }, 2))).toBe(10);
    expect(credits(imageQuote('seedream-5.5', { aspectRatio: '21:9', resolution: '1K' }, 10))).toBe(18);
    expect(credits(imageQuote('seedream-5.5', { aspectRatio: '21:9', resolution: '2K', outputFormat: 'png' }, 10))).toBe(21);
    expect(() => credits(imageQuote('seedream-5.5', { aspectRatio: '1:1', resolution: '1K' }, 11))).toThrow();
    expect(() => credits(imageQuote('seedream-5.5', { aspectRatio: 'auto', resolution: '1K' }, 1))).toThrow();
  });

  it('quotes GPT Image 2.6 at a flat 5 at 1K, with sixteen references free', () => {
    // docs/model-api-references/gpt-image-2-6.md: Economy, 1K only, eight ratios.
    expect(options('gpt-image-2.6', 'aspectRatio')).toEqual(['auto', '1:1', '16:9', '9:16', '3:2', '2:3', '21:9', '4:3']);
    expect(credits(imageQuote('gpt-image-2.6', { aspectRatio: 'auto', resolution: '1K' }))).toBe(5);
    expect(credits(imageQuote('gpt-image-2.6', { aspectRatio: '4:3', resolution: '1K' }, 16))).toBe(5);
    expect(() => credits(imageQuote('gpt-image-2.6', { aspectRatio: '1:1', resolution: '2K' }))).toThrow();
    expect(() => credits(imageQuote('gpt-image-2.6', { aspectRatio: '3:4', resolution: '1K' }))).toThrow();
    expect(() => credits(imageQuote('gpt-image-2.6', { aspectRatio: '1:1', resolution: '1K' }, 17))).toThrow();
  });

  it('quotes Kling 4.0 Flash at 17 per second for text, a start frame or ten pictures, 720p, 3–20 s', () => {
    // docs/model-api-references/kling-4-0-flash.md: the no-clip rate on both endpoints.
    expect(options('kling-4.0-flash', 'resolution')).toEqual(['720p']);
    expect(options('kling-4.0-flash', 'aspectRatio')).toEqual(['16:9', '9:16', '1:1', '21:9']);
    expect(descriptor('kling-4.0-flash').controls.map((control) => control.key)).not.toContain('sound');
    expect(credits(videoQuote('kling-4.0-flash', { aspectRatio: '16:9', resolution: '720p', duration: 5 }))).toBe(85);
    expect(credits(videoQuote('kling-4.0-flash', { aspectRatio: '21:9', resolution: '720p', duration: 20 }))).toBe(340);
    const frames = { aspectRatio: '16:9', resolution: '720p', duration: 5, referenceMode: 'frames' };
    expect(credits(videoQuote('kling-4.0-flash', frames, { startFrame: 1 }))).toBe(85);
    // The Flash keyframe endpoint takes no last frame.
    expect(() => credits(videoQuote('kling-4.0-flash', frames, { startFrame: 1, endFrame: 1 }))).toThrow();
    const references = { aspectRatio: '1:1', resolution: '720p', duration: 10, referenceMode: 'elements' };
    expect(credits(videoQuote('kling-4.0-flash', references, { imageReferences: 10 }))).toBe(170);
    expect(() => credits(videoQuote('kling-4.0-flash', references, { imageReferences: 11 }))).toThrow();
    expect(() => credits(videoQuote('kling-4.0-flash', { ...frames, duration: 2 }))).toThrow();
    expect(() => credits(videoQuote('kling-4.0-flash', { ...frames, duration: 21 }))).toThrow();
    expect(() => credits(videoQuote('kling-4.0-flash', { ...frames, resolution: '1080p' }))).toThrow();
  });

  it('quotes Gemini Omni 1.2 Flash per second by resolution, a frame pair at most 10 s', () => {
    // docs/model-api-references/gemini-omni-1-2-flash.md: 4 / 9 / 10 / 22 per second.
    expect(options('gemini-omni-1.2-flash', 'resolution')).toEqual(['360p', '720p', '1080p', '4k']);
    expect(options('gemini-omni-1.2-flash', 'aspectRatio')).toEqual(['16:9', '9:16']);
    expect(credits(videoQuote('gemini-omni-1.2-flash', { aspectRatio: '16:9', resolution: '360p', duration: 3 }))).toBe(12);
    expect(credits(videoQuote('gemini-omni-1.2-flash', { aspectRatio: '16:9', resolution: '720p', duration: 6 }))).toBe(54);
    expect(credits(videoQuote('gemini-omni-1.2-flash', { aspectRatio: '9:16', resolution: '1080p', duration: 8 }))).toBe(80);
    expect(credits(videoQuote('gemini-omni-1.2-flash', { aspectRatio: '9:16', resolution: '4k', duration: 15 }))).toBe(330);
    const frames = { aspectRatio: '16:9', resolution: '720p', referenceMode: 'frames' };
    expect(credits(videoQuote('gemini-omni-1.2-flash', { ...frames, duration: 15 }, { startFrame: 1 }))).toBe(135);
    expect(credits(videoQuote('gemini-omni-1.2-flash', { ...frames, duration: 10 }, { startFrame: 1, endFrame: 1 }))).toBe(90);
    expect(refusal(videoQuote('gemini-omni-1.2-flash', { ...frames, duration: 11 }, { startFrame: 1, endFrame: 1 }))).toEqual({
      duration: 'Gemini Omni 1.2 Flash keeps a start and end frame run to 10 seconds; drop the end frame for a longer clip.',
    });
    expect(() => credits(videoQuote('gemini-omni-1.2-flash', { ...frames, duration: 5 }, { endFrame: 1 }))).toThrow();
    const references = { aspectRatio: '16:9', resolution: '720p', duration: 6, referenceMode: 'elements' };
    expect(credits(videoQuote('gemini-omni-1.2-flash', references, { imageReferences: 6 }))).toBe(54);
    expect(() => credits(videoQuote('gemini-omni-1.2-flash', references, { imageReferences: 7 }))).toThrow();
    // No clip slot: its video edit bills the input clip's length, which the catalog cannot price.
    expect(descriptor('gemini-omni-1.2-flash').inputs.videoReferences).toBeNull();
    expect(() => credits(videoQuote('gemini-omni-1.2-flash', { ...frames, duration: 2 }))).toThrow();
    expect(() => credits(videoQuote('gemini-omni-1.2-flash', { ...frames, duration: 16 }))).toThrow();
  });
});
