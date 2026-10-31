import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  buildGenerationModelCatalog,
  quoteGenerationModel,
} from '@/lib/generation-model-catalog';
import {
  buildCodeGenerationModelOperations,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import {
  catalogRunQuoteInput,
  type CatalogRunInputFact,
} from '../../ugc-mobile/lib/model-catalog/protocol';

import { descriptorBeforeMiniDefault } from './fixtures/mini-default-video-2026-10-28';
import { descriptorBeforeVeoQualityReferences } from './fixtures/veo-quality-references-2026-10-30';
import { descriptorBeforeSlotMinDurations } from './fixtures/slot-min-durations-2026-10-31';

/**
 * Release 2026-10-20-kie-checkup: the Kie check-up of 2026-10-20
 * (archive/model-checkup-2026-10-20/README.md, pinned in kie-checkup-2026-10-20.test.ts).
 * Kie's list prices for Seedance 2 Mini and Fast after their offers ended, Seedance 2.5 at
 * 1080p after its offer ended, and PixVerse V6 references at the standard rate; MiniMax H3
 * caps references at the five Kie includes; Nano Banana 2 takes 10 references and neither
 * Nano Banana tier offers or sends `google_search`; Gemini Omni clips stop at 30 s, Seedance
 * 2.5 reference audio at 30 s in total, Wan 2.7's voice at 10 s and never alone; Veo 3.1
 * reference runs are 16:9 or 9:16. Every entry must equal the code build (the shadow
 * verifier diffs projections), and the release changes these eleven models only.
 */

interface ManifestEntry {
  modelId: string;
  kind: 'image' | 'video' | 'motion';
  webEnabled: boolean;
  mobileEnabled: boolean;
  adapterKey: string;
  adapterConfig: Record<string, unknown>;
  providerModelMap: Record<string, string>;
  pricingStrategy: string;
  pricingConfig: Record<string, unknown>;
  validationStrategy: string;
  validationConfig: Record<string, unknown>;
  verificationConfig: Record<string, unknown>;
  publicDescriptor: Record<string, unknown>;
}

interface Manifest {
  mode: string;
  release: { revision: string; basedOnRevision: string; schemaVersion: number };
  expectedModelIds: string[];
  addsModelIds?: string[];
  acceptanceQuotes?: Array<{ modelId: string; expectedCredits: number }>;
  entries: ManifestEntry[];
}

function read(name: string): Manifest {
  return JSON.parse(fs.readFileSync(path.resolve(
    process.cwd(),
    `config/generation-model-catalog/releases/${name}`,
  ), 'utf8')) as Manifest;
}

const manifest = read('2026-10-20-kie-checkup.json');
const base = read('2026-10-19-wan-start-frame-apart.json');

const CHANGED = [
  'nano-banana-2',
  'nano-banana-pro',
  'seedance-2-mini',
  'seedance-2-fast',
  'seedance-2-5',
  'pixverse-v6',
  'minimax-h3',
  'gemini-omni-video',
  'gemini-omni-1.1-flash',
  'wan-2.7',
  'veo-3.1',
];

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();

function entry(modelId: string): ManifestEntry {
  const found = manifest.entries.find((candidate) => candidate.modelId === modelId);
  if (!found) throw new Error(`no manifest entry for ${modelId}`);
  return found;
}

/** Quotes a run against the release's own entry, as production will once it is published. */
function quoteRun(modelId: string, settings: Record<string, string | number | boolean>, inputs: CatalogRunInputFact[] = []) {
  const released = entry(modelId);
  const config: GenerationModelOperationalConfig = {
    modelId: released.modelId,
    kind: released.kind,
    adapterKey: released.adapterKey as GenerationModelOperationalConfig['adapterKey'],
    adapterConfig: released.adapterConfig,
    providerModelMap: released.providerModelMap,
    pricingStrategy: released.pricingStrategy as GenerationModelOperationalConfig['pricingStrategy'],
    pricingConfig: released.pricingConfig,
    validationStrategy: released.validationStrategy as GenerationModelOperationalConfig['validationStrategy'],
    validationConfig: released.validationConfig,
    verificationConfig: released.verificationConfig,
  };
  return quoteGenerationModel(catalogRunQuoteInput({
    kind: released.kind,
    modelId,
    catalogRevision: catalog.revision,
    settings,
    inputs,
  }), { catalog, operations: new Map([[modelId, config]]) });
}

function refused(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.fieldErrors;
    throw error;
  }
  throw new Error('expected the quote to be refused');
}

const picture: CatalogRunInputFact = { slot: 'imageReferences', kind: 'image' };
const clip = (durationSeconds: number): CatalogRunInputFact => ({ slot: 'videoReferences', kind: 'video', durationSeconds });
const times = (count: number, input: CatalogRunInputFact) => Array.from({ length: count }, () => input);

describe('kie-checkup release', () => {
  it('chains onto the release production is running and changes the eleven models only', () => {
    expect(manifest.release.revision).toBe('kie-checkup-20261020');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((candidate) => candidate.modelId)).toEqual(CHANGED);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds].sort());
    expect(manifest.acceptanceQuotes?.map((quote) => quote.modelId)).toEqual([
      'seedance-2-mini', 'seedance-2-mini', 'seedance-2-mini',
      'seedance-2-fast', 'seedance-2-fast',
      'seedance-2-5', 'seedance-2-5',
      'minimax-h3',
    ]);
  });

  it.each(CHANGED)('%s is the code build', (modelId) => {
    const released = entry(modelId);
    const operation = operations.find((candidate) => candidate.modelId === modelId)!;
    const { schemaVersion, ...publicDescriptor } = released.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(descriptorBeforeMiniDefault(descriptorBeforeVeoQualityReferences(
      descriptorBeforeSlotMinDurations(catalog.models.find((model) => model.id === modelId)!),
    )));
    expect(released.webEnabled).toBe(true);
    expect(released.mobileEnabled).toBe(true);
    expect(released.adapterKey).toBe(operation.adapterKey);
    expect(released.adapterConfig).toEqual(operation.adapterConfig);
    expect(released.providerModelMap).toEqual(operation.providerModelMap);
    expect(released.pricingStrategy).toBe(operation.pricingStrategy);
    expect(released.pricingConfig).toEqual(operation.pricingConfig);
    expect(released.validationStrategy).toBe(operation.validationStrategy);
    // The emitter drops an empty passthroughSettingKeys, which the runtime reads as absent.
    const { passthroughSettingKeys, ...validationConfig } = operation.validationConfig as Record<string, unknown>;
    expect(released.validationConfig).toEqual(
      Array.isArray(passthroughSettingKeys) && passthroughSettingKeys.length > 0
        ? { ...validationConfig, passthroughSettingKeys }
        : validationConfig,
    );
  });

  it('quotes Kie\'s list prices', () => {
    // Seedance 2 Mini 3.8 / 8.2 a second without a clip, 2.4 / 5 with one (input + output seconds).
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '480p', duration: 4, sound: false }).costCredits).toBe(16);
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '720p', duration: 10 }).costCredits).toBe(82);
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '720p', duration: 5, referenceMode: 'elements' }, [clip(5)]).costCredits).toBe(50);
    // Seedance 2 Fast 11.7 / 24.8.
    expect(quoteRun('seedance-2-fast', { aspectRatio: '16:9', resolution: '480p', duration: 5 }).costCredits).toBe(59);
    expect(quoteRun('seedance-2-fast', { aspectRatio: '16:9', resolution: '720p', duration: 5 }).costCredits).toBe(124);
    // Seedance 2.5 at 1080p 158 / 95.
    expect(quoteRun('seedance-2-5', { aspectRatio: '16:9', resolution: '1080p', duration: 5 }).costCredits).toBe(790);
    expect(quoteRun('seedance-2-5', { aspectRatio: '16:9', resolution: '1080p', duration: 5, referenceMode: 'elements' }, [clip(5)]).costCredits).toBe(950);
    // PixVerse V6 references at the text rate: 720p with sound 9.6 a second.
    expect(quoteRun('pixverse-v6', { aspectRatio: '16:9', resolution: '720p', duration: 10, sound: true, referenceMode: 'elements' }, [picture]).costCredits).toBe(96);
    expect(quoteRun('pixverse-v6', { aspectRatio: '16:9', resolution: '720p', duration: 10, sound: true }).costCredits).toBe(96);
  });

  it('holds MiniMax H3 to five references and Nano Banana 2 to ten', () => {
    expect(quoteRun('minimax-h3', { aspectRatio: '16:9', resolution: '768P', duration: 6, referenceMode: 'elements' }, times(5, picture)).costCredits).toBe(48);
    expect(Object.keys(refused(() => quoteRun('minimax-h3', { aspectRatio: '16:9', resolution: '768P', duration: 6, referenceMode: 'elements' }, times(6, picture))))).not.toHaveLength(0);
    expect(quoteRun('nano-banana-2', { aspectRatio: '1:1', resolution: '1K' }, times(10, picture)).costCredits).toBe(8);
    expect(Object.keys(refused(() => quoteRun('nano-banana-2', { aspectRatio: '1:1', resolution: '1K' }, times(11, picture))))).not.toHaveLength(0);
  });

  it('refuses what Kie refuses: a Gemini clip over 30 s, a Veo reference run at Auto', () => {
    expect(Object.keys(refused(() => quoteRun('gemini-omni-video', { aspectRatio: '16:9' }, [clip(31)])))).not.toHaveLength(0);
    expect(Object.keys(refused(() => quoteRun('veo-3.1', { aspectRatio: 'Auto', mode: 'veo3_fast', resolution: '720p', referenceMode: 'elements' }, [picture])))).not.toHaveLength(0);
    expect(quoteRun('veo-3.1', { aspectRatio: '16:9', mode: 'veo3_fast', resolution: '720p', referenceMode: 'elements' }, [picture]).costCredits).toBe(60);
  });
});
