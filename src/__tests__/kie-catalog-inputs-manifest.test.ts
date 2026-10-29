import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  buildGenerationModelCatalog,
  quoteGenerationModel,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import {
  buildCodeGenerationModelOperations,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import {
  catalogRunQuoteInput,
  type CatalogRunInputFact,
} from '../../ugc-mobile/lib/model-catalog/protocol';

import { descriptorBeforeKieCatalogInputs, operationBeforeKieCatalogInputs } from './fixtures/kie-catalog-inputs-2026-10-29';

/**
 * Release 2026-10-29-kie-catalog-inputs: three web video models whose published inputs disagreed
 * with Kie, re-read that day (docs/model-api-references/kie-catalog-inputs-2026-10-29.md).
 * Grok Imagine Video takes up to 7 reference pictures where the catalog offered 1. Grok Imagine
 * Video 1.5 takes a start and an end frame of its own, and its start frame beside its pictures,
 * which two paid runs that day confirmed (the owner's "Yes, test and offer"). Seedance 1.5 Pro
 * is retired upstream, so it is offered on no platform. Every entry must equal the code build
 * (the shadow verifier diffs projections), and each changes only what this release names.
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
  defaults: Record<'web' | 'mobile', Record<'image' | 'video' | 'motion', string>>;
  entries: ManifestEntry[];
}

function read(name: string): Manifest {
  return JSON.parse(fs.readFileSync(path.resolve(
    process.cwd(),
    `config/generation-model-catalog/releases/${name}`,
  ), 'utf8')) as Manifest;
}

const manifest = read('2026-10-29-kie-catalog-inputs.json');
const base = read('2026-10-28-mini-default-video.json');
// Production's entries until this release: the last releases that carried each model.
const previous: Record<string, ManifestEntry> = {
  'grok-imagine-video': read('2026-09-04-reference-audit.json').entries.find((entry) => entry.modelId === 'grok-imagine-video')!,
  'grok-imagine-video-1.5': read('2026-10-08-kie-video-models.json').entries.find((entry) => entry.modelId === 'grok-imagine-video-1.5')!,
  'seedance-1.5-pro': read('2026-09-04-reference-audit.json').entries.find((entry) => entry.modelId === 'seedance-1.5-pro')!,
};

const CHANGED = ['grok-imagine-video', 'grok-imagine-video-1.5', 'seedance-1.5-pro'] as const;

// A release carries a model offered nowhere, so its entries are read off the full build.
const releaseBuild = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2, includeUnavailable: true });
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

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return Object.values(error.fieldErrors)[0] ?? error.message;
    throw error;
  }
  throw new Error('expected the quote to be refused');
}

const picture: CatalogRunInputFact = { slot: 'imageReferences', kind: 'image' };
const startFrame: CatalogRunInputFact = { slot: 'startFrame', kind: 'image' };
const endFrame: CatalogRunInputFact = { slot: 'endFrame', kind: 'image' };
const times = (count: number, input: CatalogRunInputFact) => Array.from({ length: count }, () => input);
const references = { aspectRatio: '16:9', resolution: '480p', duration: 8, referenceMode: 'elements' };
const frames = { aspectRatio: '16:9', resolution: '480p', duration: 8, referenceMode: 'frames' };

describe('kie-catalog-inputs release', () => {
  it('chains onto the release production is running and changes the three models only', () => {
    expect(manifest.release.revision).toBe('kie-catalog-inputs-20261029');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((candidate) => candidate.modelId)).toEqual([...CHANGED]);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    expect(manifest.defaults).toEqual(base.defaults);
  });

  it.each(CHANGED)('%s is the code build', (modelId) => {
    const released = entry(modelId);
    const operation = operations.find((candidate) => candidate.modelId === modelId)!;
    const { schemaVersion, ...publicDescriptor } = released.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(releaseBuild.models.find((model) => model.id === modelId));
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

  it('changes the inputs and availability it names, and no price', () => {
    // The fixture the earlier release tests read today's build through, against production's entries.
    for (const modelId of CHANGED) {
      const released = entry(modelId);
      const operation = operationBeforeKieCatalogInputs(released as unknown as GenerationModelOperationalConfig);
      expect({
        ...released,
        validationConfig: operation.validationConfig,
        publicDescriptor: descriptorBeforeKieCatalogInputs(released.publicDescriptor as unknown as GenerationModelDescriptor),
        webEnabled: true,
        mobileEnabled: true,
      }, modelId).toEqual(previous[modelId]);
      expect(released.pricingConfig, modelId).toEqual(previous[modelId].pricingConfig);
    }
  });

  it('offers Seedance 1.5 Pro on no platform and keeps every other model where it was', () => {
    expect(entry('seedance-1.5-pro')).toMatchObject({ webEnabled: false, mobileEnabled: false });
    expect(entry('seedance-1.5-pro').publicDescriptor.availability).toEqual({ web: false, mobile: false });
    for (const platform of ['web', 'mobile'] as const) {
      const offered = buildGenerationModelCatalog({ platform, schemaVersion: 2 }).models.map((model) => model.id);
      expect(offered, platform).not.toContain('seedance-1.5-pro');
      expect(offered, platform).toEqual(expect.arrayContaining(['grok-imagine-video', 'grok-imagine-video-1.5', 'seedance-2-mini']));
    }
    expect(refusal(() => quoteRun('seedance-1.5-pro', { aspectRatio: '16:9', resolution: '480p', duration: 4 })))
      .toBe('This model is no longer available.');
  });

  it('quotes Grok Imagine Video with up to seven pictures at its per-second price', () => {
    // 2.4 credits a second at 480p (models.ts), rounded up: 8 s is 20.
    expect(quoteRun('grok-imagine-video', { ...references, mode: 'normal' }, times(7, picture)).costCredits).toBe(20);
    expect(quoteRun('grok-imagine-video', { ...frames, mode: 'normal' }, [startFrame]).costCredits).toBe(20);
    expect(refusal(() => quoteRun('grok-imagine-video', { ...references, mode: 'normal' }, times(8, picture))))
      .toMatch(/7/);
  });

  it('quotes Grok Imagine Video 1.5 with two frames, or a start frame beside seven pictures', () => {
    expect(quoteRun('grok-imagine-video-1.5', frames, [startFrame, endFrame]).costCredits).toBe(20);
    expect(quoteRun('grok-imagine-video-1.5', references, [...times(7, picture), startFrame]).costCredits).toBe(20);
    // 4.5 a second at 720p: 15 s is 68, as before.
    expect(quoteRun('grok-imagine-video-1.5', { ...frames, resolution: '720p', duration: 15 }).costCredits).toBe(68);
    // The slot's own cap answers first; the rule behind it counts the same slot.
    expect(refusal(() => quoteRun('grok-imagine-video-1.5', references, [...times(8, picture), startFrame])))
      .toBe('Reference images supports up to 7.');
    expect(entry('grok-imagine-video-1.5').validationConfig.rules).toContainEqual(expect.objectContaining({
      type: 'max-slot-count',
      slotKey: 'imageReferences',
      max: 7,
      message: 'Grok Imagine Video 1.5 supports up to 7 reference images.',
    }));
    expect(refusal(() => quoteRun('grok-imagine-video-1.5', frames, [endFrame])))
      .toBe('Add a start frame to use an end frame with this model.');
  });
});
