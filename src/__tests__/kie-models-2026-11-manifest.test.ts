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
 * Release 2026-11-05-kie-models: Nano Banana 2.1 and FLUX.3 Klein (images), PixVerse V6 Max,
 * Kling 4.0 and Vidu Q4 (videos) join the catalog (evidence: docs/model-api-references/
 * nano-banana-2-1.md, flux-3-klein.md, pixverse-v6-max.md, kling-4-0.md, vidu-q4.md, read
 * 2026-11-05). Every entry must equal the code build byte for byte, since the shadow verifier
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

const manifest = read('2026-11-05-kie-models.json');
const base = read('2026-11-05-kling-3-image-orientation.json');

const ADDED = ['nano-banana-2.1', 'flux-3-klein', 'pixverse-v6-max', 'kling-4.0', 'vidu-q4'];
const IMAGES = ['nano-banana-2.1', 'flux-3-klein'];
const VIDEOS = ['pixverse-v6-max', 'kling-4.0', 'vidu-q4'];

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

describe('kie-models-20261105 release', () => {
  it('chains onto the release production is running', () => {
    expect(manifest.release.revision).toBe('kie-models-20261105');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(base.release.revision).toBe('kling-3-image-orientation-20261105');
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
  });

  it('adds the five models and replaces no existing model', () => {
    expect(manifest.entries.map((entry) => entry.modelId).sort()).toEqual([...ADDED].sort());
    expect([...(manifest.addsModelIds ?? [])].sort()).toEqual([...ADDED].sort());
    // expectedModelIds guards the release being cloned: production's inventory.
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    expect(manifest.expectedModelIds).toHaveLength(45);
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
    expect(entryFor('nano-banana-2.1')).toMatchObject({ adapterKey: 'kie-task-v1', providerModelMap: { default: 'nano-banana-2-1' } });
    expect(entryFor('flux-3-klein')).toMatchObject({
      adapterKey: 'kie-task-v1',
      providerModelMap: { text: 'flux-3/klein-text-to-image', reference: 'flux-3/klein-edit-image' },
    });
    expect(entryFor('pixverse-v6-max').providerModelMap).toEqual({
      default: 'pixverse-v6-max/text-to-video',
      text: 'pixverse-v6-max/text-to-video',
      image: 'pixverse-v6-max/image-to-video',
    });
    // No kling-4.0/text-to-video exists (422); the reference endpoint is plain text-to-video
    // with no materials.
    expect(entryFor('kling-4.0').providerModelMap).toEqual({
      default: 'kling-4.0/reference-to-video',
      text: 'kling-4.0/reference-to-video',
      image: 'kling-4.0/keyframe-to-video',
      reference: 'kling-4.0/reference-to-video',
    });
    expect(entryFor('vidu-q4').providerModelMap).toEqual({
      default: 'vidu-q4/image-to-video',
      image: 'vidu-q4/image-to-video',
      reference: 'vidu-q4/reference-to-video',
    });
    for (const modelId of VIDEOS) expect(entryFor(modelId).adapterKey, modelId).toBe('video-v1');
    for (const modelId of ADDED) {
      expect(entryFor(modelId).validationStrategy, modelId).toBe('descriptor-rules-v1');
      expect(entryFor(modelId).webEnabled, modelId).toBe(true);
    }
  });

  it('keeps Vidu Q4 off mobile until an app update names ShengShu, and the rest on both', () => {
    // The installed apps name each maker in the AI-data question; ShengShu is new there.
    expect(entryFor('vidu-q4').mobileEnabled).toBe(false);
    expect(entryFor('vidu-q4').publicDescriptor.availability).toEqual({ web: true, mobile: false });
    expect(mobileCatalog.models.map((model) => model.id)).not.toContain('vidu-q4');
    for (const modelId of ADDED.filter((id) => id !== 'vidu-q4')) {
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

  it('quotes Nano Banana 2.1 at 4 / 6 / 9 with ten references free', () => {
    // docs/model-api-references/nano-banana-2-1.md.
    expect(options('nano-banana-2.1', 'resolution')).toEqual(['1K', '2K', '4K']);
    expect(options('nano-banana-2.1', 'outputFormat')).toEqual(['jpg', 'png']);
    expect(credits(imageQuote('nano-banana-2.1', { aspectRatio: 'auto', resolution: '1K' }))).toBe(4);
    expect(credits(imageQuote('nano-banana-2.1', { aspectRatio: '1:8', resolution: '2K' }, 3))).toBe(6);
    expect(credits(imageQuote('nano-banana-2.1', { aspectRatio: '21:9', resolution: '4K', outputFormat: 'png' }, 10))).toBe(9);
    expect(() => credits(imageQuote('nano-banana-2.1', { aspectRatio: '1:1', resolution: '1K' }, 11))).toThrow();
  });

  it('charges FLUX.3 Klein its fractional rates rounded up to whole credits, references free', () => {
    // docs/model-api-references/flux-3-klein.md: 1.6 / 2.5 / 6.5 a picture.
    expect(options('flux-3-klein', 'aspectRatio')).toEqual(['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21']);
    expect(options('flux-3-klein', 'outputFormat')).toEqual([]);
    expect(credits(imageQuote('flux-3-klein', { aspectRatio: '1:1', resolution: '1K' }))).toBe(2);
    expect(credits(imageQuote('flux-3-klein', { aspectRatio: '9:21', resolution: '2K' }, 10))).toBe(3);
    expect(credits(imageQuote('flux-3-klein', { aspectRatio: '16:9', resolution: '4K' }, 1))).toBe(7);
    expect(() => credits(imageQuote('flux-3-klein', { aspectRatio: 'auto', resolution: '1K' }, 1))).toThrow();
    expect(() => credits(imageQuote('flux-3-klein', { aspectRatio: '1:1', resolution: '1K' }, 11))).toThrow();
  });

  it('quotes PixVerse V6 Max by resolution and audio, from text or one start frame only', () => {
    // docs/model-api-references/pixverse-v6-max.md.
    expect(options('pixverse-v6-max', 'resolution')).toEqual(['360p', '540p', '720p', '1080p']);
    expect(options('pixverse-v6-max', 'referenceMode')).toEqual([]);
    expect(credits(videoQuote('pixverse-v6-max', { aspectRatio: '16:9', resolution: '360p', duration: 5 }))).toBe(24);
    expect(credits(videoQuote('pixverse-v6-max', { aspectRatio: '16:9', resolution: '360p', duration: 5, sound: true }))).toBe(36);
    expect(credits(videoQuote('pixverse-v6-max', { aspectRatio: '21:9', resolution: '1080p', duration: 15, sound: true }))).toBe(336);
    expect(credits(videoQuote('pixverse-v6-max', { aspectRatio: '16:9', resolution: '720p', duration: 10, referenceMode: 'frames' }, { startFrame: 1 }))).toBe(88);
    expect(() => credits(videoQuote('pixverse-v6-max', { aspectRatio: '16:9', resolution: '720p', duration: 10, referenceMode: 'frames' }, { startFrame: 1, endFrame: 1 }))).toThrow();
    expect(() => credits(videoQuote('pixverse-v6-max', { aspectRatio: '16:9', resolution: '720p', duration: 10, referenceMode: 'elements' }, { imageReferences: 1 }))).toThrow();
    expect(() => credits(videoQuote('pixverse-v6-max', { aspectRatio: '16:9', resolution: '360p', duration: 16 }))).toThrow();
  });

  it('quotes Kling 4.0 at 28.5 / 42.5 per second for text, a frame pair or ten pictures, with no sound control', () => {
    // docs/model-api-references/kling-4-0.md: the no-clip rate on both endpoints.
    expect(options('kling-4.0', 'resolution')).toEqual(['720p', '1080p']);
    expect(options('kling-4.0', 'aspectRatio')).toEqual(['16:9', '9:16', '1:1', '21:9']);
    expect(descriptor('kling-4.0').controls.map((control) => control.key)).not.toContain('sound');
    expect(credits(videoQuote('kling-4.0', { aspectRatio: '16:9', resolution: '720p', duration: 5 }))).toBe(143);
    expect(credits(videoQuote('kling-4.0', { aspectRatio: '21:9', resolution: '1080p', duration: 30 }))).toBe(1275);
    const frames = { aspectRatio: '16:9', resolution: '720p', duration: 5, referenceMode: 'frames' };
    expect(credits(videoQuote('kling-4.0', frames, { startFrame: 1, endFrame: 1 }))).toBe(143);
    expect(() => credits(videoQuote('kling-4.0', frames, { endFrame: 1 }))).toThrow();
    const references = { aspectRatio: '1:1', resolution: '1080p', duration: 10, referenceMode: 'elements' };
    expect(credits(videoQuote('kling-4.0', references, { imageReferences: 10 }))).toBe(425);
    expect(() => credits(videoQuote('kling-4.0', references, { imageReferences: 11 }))).toThrow();
    expect(() => credits(videoQuote('kling-4.0', { ...frames, duration: 2 }))).toThrow();
    expect(() => credits(videoQuote('kling-4.0', { ...frames, duration: 31 }))).toThrow();
  });

  it('quotes Vidu Q4 per second by resolution, and needs a start frame or a picture', () => {
    // docs/model-api-references/vidu-q4.md: one rate per resolution, audio or not.
    expect(options('vidu-q4', 'resolution')).toEqual(['540p', '720p', '1080p', '2k', '4k']);
    const frames = { aspectRatio: '16:9', resolution: '540p', duration: 5, referenceMode: 'frames' };
    expect(credits(videoQuote('vidu-q4', frames, { startFrame: 1 }))).toBe(36);
    expect(credits(videoQuote('vidu-q4', { ...frames, resolution: '4k', duration: 16, sound: true }, { startFrame: 1 }))).toBe(999);
    const references = { aspectRatio: '3:4', resolution: '720p', duration: 5, referenceMode: 'elements' };
    expect(credits(videoQuote('vidu-q4', references, { imageReferences: 15 }))).toBe(76);
    expect(() => credits(videoQuote('vidu-q4', references, { imageReferences: 16 }))).toThrow();
    // There is no text-only endpoint: an empty frames run, or an empty references run, is refused.
    expect(() => credits(videoQuote('vidu-q4', frames))).toThrow();
    expect(() => credits(videoQuote('vidu-q4', references))).toThrow();
    expect(() => credits(videoQuote('vidu-q4', frames, { startFrame: 1, endFrame: 1 }))).toThrow();
  });
});
