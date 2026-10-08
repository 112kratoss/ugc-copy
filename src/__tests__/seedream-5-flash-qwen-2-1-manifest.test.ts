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
 * Release 2026-10-08-seedream-5-flash-qwen-2-1: Seedream 5 Flash and Qwen Image 2.1 join the
 * catalog (evidence: docs/model-api-references/seedream-5-flash.md and qwen-image-2-1.md).
 * Every entry must equal the code build byte for byte — the shadow verifier diffs projections —
 * so entries are compared against buildGenerationModelCatalog and
 * buildCodeGenerationModelOperations, while provider ids and prices are pinned to the evidence
 * files.
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

const manifest = read('2026-10-08-seedream-5-flash-qwen-2-1.json');
const base = read('2026-09-11-gpt-image-2-5.json');

const ADDED = ['qwen-image-2.1', 'seedream-5-flash'];

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
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

function imageQuote(modelId: string, settings: Record<string, string>, images = 0): GenerationModelQuoteInput {
  return { kind: 'image', modelId, settings, inputCounts: images > 0 ? { images } : {} };
}

describe('seedream-5-flash-qwen-2-1 release', () => {
  it('chains onto the release production is running', () => {
    expect(manifest.release.revision).toBe('seedream-5-flash-qwen-2-1-20261008');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
  });

  it('adds the two image models and replaces no existing model', () => {
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
    expect(publicDescriptor).toEqual(descriptor(modelId));
    const operation = operations.get(modelId)!;
    expect(entry.kind).toBe(operation.kind);
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

  it('routes each model to the provider ids its spec declares, on the declarative adapter', () => {
    expect(entryFor('seedream-5-flash').providerModelMap).toEqual({
      text: 'seedream/5-flash-text-to-image',
      reference: 'seedream/5-flash-image-to-image',
    });
    expect(entryFor('qwen-image-2.1').providerModelMap).toEqual({
      text: 'qwen2-1/text-to-image',
      reference: 'qwen2-1/image-to-image',
    });
    for (const modelId of ADDED) {
      const entry = entryFor(modelId);
      expect(entry.adapterKey, modelId).toBe('kie-task-v1');
      expect(entry.validationStrategy, modelId).toBe('descriptor-rules-v1');
      expect(entry.webEnabled, modelId).toBe(true);
      expect(entry.mobileEnabled, modelId).toBe(true);
    }
  });

  it('stays readable by every shipped app and sorts after the image models that preceded it', () => {
    // The models production ran before this release, not whatever the code build holds
    // today: a later model sorts after these two and must not fail this pin.
    const existingSortOrders = catalog.models
      .filter((model) => model.kind === 'image' && manifest.expectedModelIds.includes(model.id))
      .map((model) => model.sortOrder);
    for (const modelId of ADDED) {
      const published = entryFor(modelId).publicDescriptor as {
        minClientSchemaVersion: number;
        sortOrder: number;
        controls: Array<{ key: string; type: string }>;
      };
      expect(published.minClientSchemaVersion, modelId).toBe(1);
      expect(published.sortOrder, modelId).toBeGreaterThan(Math.max(...existingSortOrders));
      // Existing control keys and types only: mobile's parser fails closed on a new type.
      expect(published.controls.map((control) => [control.key, control.type]), modelId).toEqual([
        ['aspectRatio', 'choice'],
        ['resolution', 'choice'],
        ['outputFormat', 'choice'],
      ]);
    }
  });

  it('quotes Seedream 5 Flash at 4 credits at either size, references free', () => {
    // Kie's 3.24 is the table value (models.ts, the evidence file); the quote bills whole
    // credits and rounds up, as it bills Seedream 5 Lite's 5.5 as 6 and Wan 2.7 Image's 4.8 as 5.
    expect(quoteGenerationModel(imageQuote('seedream-5-flash', { aspectRatio: '16:9', resolution: '1K' })).costCredits).toBe(4);
    expect(quoteGenerationModel(imageQuote('seedream-5-flash', { aspectRatio: '16:9', resolution: '2K' })).costCredits).toBe(4);
    expect(quoteGenerationModel(imageQuote('seedream-5-flash', { aspectRatio: '1:1', resolution: '2K' }, 10)).costCredits).toBe(4);
    expect(quoteGenerationModel(imageQuote('seedream-5-lite', { aspectRatio: '1:1', resolution: '2K' })).costCredits).toBe(6);
  });

  it('quotes Qwen Image 2.1 at 4 credits at 1K and 8 at 2K, references free', () => {
    expect(quoteGenerationModel(imageQuote('qwen-image-2.1', { aspectRatio: '9:21', resolution: '1K' })).costCredits).toBe(4);
    expect(quoteGenerationModel(imageQuote('qwen-image-2.1', { aspectRatio: '9:21', resolution: '2K' })).costCredits).toBe(8);
    expect(quoteGenerationModel(imageQuote('qwen-image-2.1', { aspectRatio: '1:1', resolution: '2K' }, 10)).costCredits).toBe(8);
  });

  it('offers only the ratios and sizes the specs list', () => {
    const flash = descriptor('seedream-5-flash');
    const ratios = (key: string, model: typeof flash) => {
      const control = model.controls.find((candidate) => candidate.key === key);
      return control?.type === 'choice' ? control.options.map((option) => option.value) : [];
    };
    expect(ratios('aspectRatio', flash)).toEqual(['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9']);
    // The spec's 1.5K is left out: not a size either client's ImageResolution names, and no cheaper.
    expect(ratios('resolution', flash)).toEqual(['1K', '2K']);
    const qwen = descriptor('qwen-image-2.1');
    expect(ratios('aspectRatio', qwen)).toEqual(['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21']);
    expect(ratios('resolution', qwen)).toEqual(['1K', '2K']);
  });
});
