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
 * Release 2026-10-08-kie-video-models: Gemini Omni 1.1 Flash, Wan 3.0, Wan 3.0 Prime, Grok
 * Imagine Video 1.5 Preview and PixVerse V6 join the catalog (evidence:
 * docs/model-api-references/gemini-omni-1-1-flash.md, wan-3-0.md, grok-imagine-video-1-5.md,
 * pixverse-v6.md). Every entry must equal the code build byte for byte — the shadow verifier
 * diffs projections — so entries are compared against buildGenerationModelCatalog and
 * buildCodeGenerationModelOperations, while provider ids, prices and the catches each spec
 * carries are pinned to the evidence files.
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

const manifest = read('2026-10-08-kie-video-models.json');
const base = read('2026-10-08-seedream-5-flash-qwen-2-1.json');

const ADDED = ['gemini-omni-1.1-flash', 'grok-imagine-video-1.5', 'pixverse-v6', 'wan-3.0', 'wan-3.0-prime'];

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

function videoQuote(
  modelId: string,
  settings: Record<string, string | number | boolean>,
  inputs: {
    images?: number;
    videos?: number;
    audios?: number;
    videoSeconds?: number[];
  } = {},
): GenerationModelQuoteInput {
  const { images = 0, videos = 0, audios = 0, videoSeconds } = inputs;
  return {
    kind: 'video',
    modelId,
    settings,
    inputCounts: { images, videos, audios },
    inputMetadata: {
      slots: {
        ...(images > 0 ? { imageReferences: { count: images } } : {}),
        ...(videos > 0 ? { videoReferences: { count: videos, ...(videoSeconds ? { durationsSeconds: videoSeconds } : {}) } } : {}),
        ...(audios > 0 ? { audioReferences: { count: audios } } : {}),
      },
    },
    catalogRevision: catalog.revision,
  };
}

function credits(input: GenerationModelQuoteInput): number {
  return quoteGenerationModel(input, { catalog }).costCredits;
}

describe('kie-video-models release', () => {
  it('chains onto the release production is running', () => {
    expect(manifest.release.revision).toBe('kie-video-models-20261008');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
  });

  it('adds the five video models and replaces no existing model', () => {
    expect(manifest.entries.map((entry) => entry.modelId).sort()).toEqual(ADDED);
    expect(manifest.addsModelIds).toEqual(ADDED);
    // expectedModelIds guards the release being CLONED: the base's inventory plus what the
    // base itself added, which is what production runs.
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    for (const added of ADDED) expect(manifest.expectedModelIds).not.toContain(added);
  });

  it.each(ADDED)('%s: the manifest entry is the code build', (modelId) => {
    const entry = entryFor(modelId);
    const { schemaVersion, ...publicDescriptor } = entry.publicDescriptor;
    expect(schemaVersion).toBe(2);
    // PixVerse shipped web-only in this release; release pixverse-mobile-20261008 turned
    // mobile on once the apps named its maker, so the code build differs there and only there.
    expect(publicDescriptor).toEqual(modelId === 'pixverse-v6'
      ? { ...descriptor(modelId), availability: { web: true, mobile: false } }
      : descriptor(modelId));
    const operation = operations.get(modelId)!;
    expect(entry.kind).toBe('video');
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

  it('routes each model to the provider ids its spec declares, on the legacy video adapter', () => {
    expect(entryFor('gemini-omni-1.1-flash').providerModelMap).toEqual({ default: 'google/gemini-omni-flash-1-1' });
    expect(entryFor('wan-3.0').providerModelMap).toEqual({ default: 'wan/3-0-video' });
    expect(entryFor('wan-3.0-prime').providerModelMap).toEqual({ default: 'wan/3-0-video-prime' });
    expect(entryFor('grok-imagine-video-1.5').providerModelMap).toEqual({
      default: 'grok-imagine-video-1-5-preview',
      text: 'grok-imagine-video-1-5-preview',
      image: 'grok-imagine-video-1-5-preview',
    });
    expect(entryFor('pixverse-v6').providerModelMap).toEqual({
      default: 'pixverse-v6/text-to-video',
      text: 'pixverse-v6/text-to-video',
      image: 'pixverse-v6/image-to-video',
      transition: 'pixverse-v6/transition',
      reference: 'pixverse-v6/reference-to-video',
    });
    for (const modelId of ADDED) {
      const entry = entryFor(modelId);
      expect(entry.adapterKey, modelId).toBe('video-v1');
      expect(entry.validationStrategy, modelId).toBe('descriptor-rules-v1');
      expect(entry.webEnabled, modelId).toBe(true);
    }
  });

  it('kept PixVerse V6 off mobile until an app update named its maker, and the rest on both', () => {
    // The installed apps name each maker in the AI-data question; PixVerse was new there.
    // pixverse-mobile-manifest.test.ts pins the release that turned mobile on.
    expect(entryFor('pixverse-v6').mobileEnabled).toBe(false);
    expect(entryFor('pixverse-v6').publicDescriptor.availability).toEqual({ web: true, mobile: false });
    for (const modelId of ADDED.filter((id) => id !== 'pixverse-v6')) {
      expect(entryFor(modelId).mobileEnabled, modelId).toBe(true);
      expect(mobileCatalog.models.map((model) => model.id), modelId).toContain(modelId);
    }
  });

  it('stays readable by every shipped app and sorts after the video models that preceded it', () => {
    const existingSortOrders = catalog.models
      .filter((model) => model.kind === 'video' && manifest.expectedModelIds.includes(model.id))
      .map((model) => model.sortOrder);
    for (const modelId of ADDED) {
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
          expect(['image', 'video', 'audio'], `${modelId} ${mode.key}`).toContain(slot.kind);
          expect(['reference', 'startFrame', 'endFrame'], `${modelId} ${mode.key}`).toContain(slot.role);
        }
      }
    }
  });

  it('quotes Gemini Omni 1.1 Flash from its table, 360p like 720p, and flat with a clip', () => {
    // docs/model-api-references/gemini-omni-1-1-flash.md.
    expect(options('gemini-omni-1.1-flash', 'resolution')).toEqual(['360p', '720p', '1080p', '4k']);
    expect(options('gemini-omni-1.1-flash', 'duration')).toEqual(['4', '6', '8', '10']);
    expect(credits(videoQuote('gemini-omni-1.1-flash', { aspectRatio: '16:9', resolution: '360p', duration: 4 }))).toBe(63);
    expect(credits(videoQuote('gemini-omni-1.1-flash', { aspectRatio: '9:16', resolution: '1080p', duration: 10 }))).toBe(126);
    expect(credits(videoQuote('gemini-omni-1.1-flash', { aspectRatio: '16:9', resolution: '4k', duration: 6 }))).toBe(168);
    const withClip = { aspectRatio: '16:9', resolution: '720p', duration: 8, referenceMode: 'elements' };
    expect(credits(videoQuote('gemini-omni-1.1-flash', withClip, { videos: 1, videoSeconds: [5] }))).toBe(168);
    expect(credits(videoQuote('gemini-omni-1.1-flash', { ...withClip, resolution: '4k' }, { videos: 1, videoSeconds: [5] }))).toBe(252);
    // Seven slots, a clip takes two: six pictures and a clip is one too many.
    expect(() => credits(videoQuote('gemini-omni-1.1-flash', withClip, { images: 6, videos: 1, videoSeconds: [5] }))).toThrow();
    expect(credits(videoQuote('gemini-omni-1.1-flash', withClip, { images: 5, videos: 1, videoSeconds: [5] }))).toBe(168);
  });

  it('quotes Wan 3.0 and Prime per second, adds reference-clip seconds, and refuses -1', () => {
    // docs/model-api-references/wan-3-0.md: billed seconds = output + reference clips.
    expect(options('wan-3.0', 'resolution')).toEqual(['480P', '720P', '1080P']);
    expect(credits(videoQuote('wan-3.0', { aspectRatio: '16:9', resolution: '480P', duration: 5 }))).toBe(40);
    expect(credits(videoQuote('wan-3.0', { aspectRatio: '16:9', resolution: '1080P', duration: 30 }))).toBe(960);
    expect(credits(videoQuote('wan-3.0-prime', { aspectRatio: '1:1', resolution: '720P', duration: 10 }))).toBe(252);
    expect(credits(videoQuote('wan-3.0-prime', { aspectRatio: '1:1', resolution: '480P', duration: 5 }))).toBe(61);
    const reference = { aspectRatio: '16:9', resolution: '480P', duration: 5, referenceMode: 'elements' };
    expect(credits(videoQuote('wan-3.0', reference, { videos: 1, videoSeconds: [10] }))).toBe(120);
    expect(credits(videoQuote('wan-3.0', reference, { images: 10, videos: 2, videoSeconds: [7, 8] }))).toBe(160);
    // The spec's "intelligent duration" (-1) cannot be priced up front and is not a value.
    expect(() => credits(videoQuote('wan-3.0', { aspectRatio: '16:9', resolution: '480P', duration: -1 }))).toThrow();
    // Clips may total 15 s and input plus output may not pass 30: a reference run stops at 15.
    expect(() => credits(videoQuote('wan-3.0', { ...reference, duration: 16 }, { videos: 1, videoSeconds: [5] }))).toThrow();
    expect(() => credits(videoQuote('wan-3.0', reference, { videos: 2, videoSeconds: [10, 10] }))).toThrow();
    expect(credits(videoQuote('wan-3.0', { aspectRatio: '16:9', resolution: '480P', duration: 30 }))).toBe(240);
  });

  it('quotes Grok Imagine Video 1.5 at 2.4 / 4.5 per second and offers no 1080p', () => {
    // docs/model-api-references/grok-imagine-video-1-5.md: 1080p is in the schema, unpriced.
    expect(options('grok-imagine-video-1.5', 'resolution')).toEqual(['480p', '720p']);
    expect(options('grok-imagine-video-1.5', 'mode')).toEqual([]);
    expect(credits(videoQuote('grok-imagine-video-1.5', { aspectRatio: '16:9', resolution: '480p', duration: 8 }))).toBe(20);
    expect(credits(videoQuote('grok-imagine-video-1.5', { aspectRatio: '16:9', resolution: '720p', duration: 15 }))).toBe(68);
    expect(() => credits(videoQuote('grok-imagine-video-1.5', { aspectRatio: '16:9', resolution: '1080p', duration: 8 }))).toThrow();
    expect(() => credits(videoQuote('grok-imagine-video-1.5', { aspectRatio: '16:9', resolution: '480p', duration: 16 }))).toThrow();
  });

  it('quotes PixVerse V6 by resolution and audio, with the reference-to-video uplift', () => {
    // docs/model-api-references/pixverse-v6.md.
    expect(options('pixverse-v6', 'resolution')).toEqual(['360p', '540p', '720p', '1080p']);
    expect(credits(videoQuote('pixverse-v6', { aspectRatio: '16:9', resolution: '360p', duration: 5 }))).toBe(20);
    expect(credits(videoQuote('pixverse-v6', { aspectRatio: '16:9', resolution: '360p', duration: 5, sound: true }))).toBe(28);
    expect(credits(videoQuote('pixverse-v6', { aspectRatio: '16:9', resolution: '1080p', duration: 10, sound: true }))).toBe(184);
    const reference = { aspectRatio: '16:9', resolution: '720p', duration: 10, referenceMode: 'elements' };
    expect(credits(videoQuote('pixverse-v6', reference, { images: 1 }))).toBe(81);
    expect(credits(videoQuote('pixverse-v6', { ...reference, sound: true }, { images: 7 }))).toBe(108);
    expect(() => credits(videoQuote('pixverse-v6', reference, { images: 8 }))).toThrow();
    // A start frame or a frame pair is not a reference: the base table applies.
    expect(credits({
      kind: 'video',
      modelId: 'pixverse-v6',
      settings: { aspectRatio: '16:9', resolution: '540p', duration: 5, referenceMode: 'frames' },
      inputCounts: { images: 2, videos: 0, audios: 0 },
      inputMetadata: { slots: { startFrame: { count: 1 }, endFrame: { count: 1 } } },
      catalogRevision: catalog.revision,
    })).toBe(28);
  });
});
