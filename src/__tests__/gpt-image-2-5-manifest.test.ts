import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
  CatalogError,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * Release 2026-09-11-gpt-image-2-5: GPT Image 2.5 Flare and Sunburst join the catalog next to
 * GPT Image 2, which stays (evidence: docs/model-api-references/gpt-image-2-5.md). Every entry must
 * equal the code build byte for byte — the shadow verifier diffs projections — so entries are
 * compared against buildGenerationModelCatalog and buildCodeGenerationModelOperations, while
 * provider ids and prices are pinned to the evidence file.
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

const manifest = read('2026-09-11-gpt-image-2-5.json');
const base = read('2026-09-04-reference-audit.json');

const ADDED = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];

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

function fieldErrorsFor(input: GenerationModelQuoteInput): string {
  try {
    quoteGenerationModel(input);
  } catch (error) {
    if (error instanceof CatalogError) return Object.values(error.fieldErrors).join(' ');
    throw error;
  }
  throw new Error('expected the quote to be rejected');
}

describe('gpt-image-2-5 release', () => {
  it('chains onto the release production is running', () => {
    expect(manifest.release.revision).toBe('gpt-image-2-5-20260911');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
  });

  it('adds the two tiers and replaces no existing model, GPT Image 2 included', () => {
    expect(manifest.entries.map((entry) => entry.modelId).sort()).toEqual(ADDED);
    expect(manifest.addsModelIds).toEqual(ADDED);
    // expectedModelIds guards the release being CLONED, so it is the base's inventory exactly;
    // the base added nothing, so its own expectedModelIds is what production runs.
    expect(manifest.expectedModelIds).toEqual(base.expectedModelIds);
    expect(manifest.expectedModelIds).toContain('gpt-image-2');
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

  it('routes each tier to the provider ids its spec declares, on the declarative adapter', () => {
    expect(entryFor('gpt-image-2.5-flare').providerModelMap).toEqual({
      text: 'gpt-image-2-5-flare-text-to-image',
      reference: 'gpt-image-2-5-flare-image-to-image',
    });
    expect(entryFor('gpt-image-2.5-sunburst').providerModelMap).toEqual({
      text: 'gpt-image-2-5-sunburst-text-to-image',
      reference: 'gpt-image-2-5-sunburst-image-to-image',
    });
    for (const modelId of ADDED) {
      const entry = entryFor(modelId);
      expect(entry.adapterKey, modelId).toBe('kie-task-v1');
      expect(entry.validationStrategy, modelId).toBe('descriptor-rules-v1');
      expect(entry.webEnabled, modelId).toBe(true);
      expect(entry.mobileEnabled, modelId).toBe(true);
    }
  });

  it('stays readable by every shipped app and sorts after the existing image models', () => {
    const existingSortOrders = catalog.models
      .filter((model) => model.kind === 'image' && !ADDED.includes(model.id))
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
      ]);
    }
  });

  it('quotes both tiers at 6 / 10 / 16 credits, references included', () => {
    for (const modelId of ADDED) {
      expect(quoteGenerationModel(imageQuote(modelId, { aspectRatio: '16:9', resolution: '1K' })).costCredits).toBe(6);
      expect(quoteGenerationModel(imageQuote(modelId, { aspectRatio: '16:9', resolution: '2K' })).costCredits).toBe(10);
      expect(quoteGenerationModel(imageQuote(modelId, { aspectRatio: '16:9', resolution: '4K' })).costCredits).toBe(16);
      expect(quoteGenerationModel(imageQuote(modelId, { aspectRatio: '16:9', resolution: '4K' }, 16)).costCredits).toBe(16);
    }
  });

  it('refuses the resolutions Kie cannot render, and names the cap', () => {
    for (const modelId of ADDED) {
      for (const aspectRatio of ['27:16', '16:27', '9:8', '8:9', 'auto']) {
        expect(fieldErrorsFor(imageQuote(modelId, { aspectRatio, resolution: '2K' })), `${modelId} ${aspectRatio}`)
          .toMatch(/at 1K only/);
        expect(() => quoteGenerationModel(imageQuote(modelId, { aspectRatio, resolution: '1K' }))).not.toThrow();
      }
      expect(fieldErrorsFor(imageQuote(modelId, { aspectRatio: '1:1', resolution: '4K' }))).toMatch(/at 1K or 2K only/);
      expect(() => quoteGenerationModel(imageQuote(modelId, { aspectRatio: '1:1', resolution: '2K' }))).not.toThrow();
      expect(() => quoteGenerationModel(imageQuote(modelId, { aspectRatio: '21:9', resolution: '4K' }))).not.toThrow();
    }
  });
});
