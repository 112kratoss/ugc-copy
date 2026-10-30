import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  buildGenerationModelCatalog,
  projectGenerationModelDescriptor,
  quoteGenerationModel,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import { parsePublishedModelDescriptor } from '@/lib/generation-model-descriptor-parser';
import {
  buildCodeGenerationModelOperations,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import {
  CLIENT_RENDERED_CONTROL_TYPES,
  catalogConditionsMatch,
  catalogRunQuoteInput,
  type CatalogRunInputFact,
} from '../../ugc-mobile/lib/model-catalog/protocol';

import { descriptorBeforeVeoQualityReferences } from './fixtures/veo-quality-references-2026-10-30';

/**
 * Release 2026-10-30-veo-quality-references: Veo 3.1 offers reference pictures on Lite and Fast
 * only. Kie's REFERENCE_2_VIDEO supports veo3_fast and veo3_lite (docs/model-api-references/veo-3-1.md,
 * re-read 2026-10-30), and the quote refused references on Quality, while the descriptor opened its
 * references input mode on every variant: both creators offered Quality a run its own quote refused
 * (the 2026-10-29 Kie audit, archive/creator-page-build-2026-10-28/pr4/kie-audit.md). The mode now
 * opens on the two variants that take pictures. The entry must equal the code build, and changes
 * that gate alone.
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

const manifest = read('2026-10-30-veo-quality-references.json');
const base = read('2026-10-29-kie-catalog-inputs.json');
// Production's entry until this release: the last release that carried Veo 3.1.
const previous = read('2026-10-20-kie-checkup.json').entries.find((entry) => entry.modelId === 'veo-3.1')!;

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();
const released = manifest.entries.find((entry) => entry.modelId === 'veo-3.1')!;
// The descriptor as production's catalog store reads it back from the release.
const published = projectGenerationModelDescriptor(parsePublishedModelDescriptor(
  released.publicDescriptor,
  'veo-3.1',
  manifest.release.schemaVersion,
  { web: released.webEnabled, mobile: released.mobileEnabled },
), 2);

// The release's own entry, as production's catalog will serve and quote it once it is published.
const publishedCatalog = { ...catalog, models: catalog.models.map((model) => (model.id === 'veo-3.1' ? published : model)) };
const publishedOperations = new Map<string, GenerationModelOperationalConfig>([['veo-3.1', {
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
}]]);

/** Quotes a Veo 3.1 run as both creators ask for it, against the release's own entry. */
function quoteRun(settings: Record<string, string | number | boolean>, inputs: CatalogRunInputFact[] = []) {
  return quoteGenerationModel(catalogRunQuoteInput({
    kind: 'video',
    modelId: 'veo-3.1',
    catalogRevision: catalog.revision,
    settings,
    inputs,
  }), { catalog: publishedCatalog, operations: publishedOperations });
}

function refusal(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.fieldErrors;
    throw error;
  }
  throw new Error('expected the quote to be refused');
}

const picture: CatalogRunInputFact = { slot: 'imageReferences', kind: 'image' };
const startFrame: CatalogRunInputFact = { slot: 'startFrame', kind: 'image' };
const endFrame: CatalogRunInputFact = { slot: 'endFrame', kind: 'image' };
const times = (count: number, input: CatalogRunInputFact) => Array.from({ length: count }, () => input);
const run = (mode: string, referenceMode: string, extra: Record<string, string> = {}) => ({
  aspectRatio: '16:9', resolution: '720p', duration: 8, mode, referenceMode, ...extra,
});

describe('veo-quality-references release', () => {
  it('chains onto the release production is running and changes Veo 3.1 only', () => {
    expect(manifest.release.revision).toBe('veo-quality-references-20261030');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((entry) => entry.modelId)).toEqual(['veo-3.1']);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    expect(manifest.defaults).toEqual(base.defaults);
  });

  it('is the code build', () => {
    const operation = operations.find((candidate) => candidate.modelId === 'veo-3.1')!;
    const { schemaVersion, ...publicDescriptor } = released.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(catalog.models.find((model) => model.id === 'veo-3.1'));
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

  it('changes the references mode\'s gate and nothing else: no price, rule, slot or platform', () => {
    // The fixture the earlier release tests read today's build through, against production's entry.
    expect({
      ...released,
      publicDescriptor: descriptorBeforeVeoQualityReferences(released.publicDescriptor as unknown as GenerationModelDescriptor),
    }).toEqual(previous);
  });

  it('opens the reference pictures on Lite and Fast only, and the frames on every variant', () => {
    const modes = published.inputModes ?? [];
    const variants = published.controls.find((control) => control.key === 'mode');
    expect(variants?.type === 'choice' && variants.options.map((option) => option.value)).toEqual(['veo3_lite', 'veo3_fast', 'veo3']);
    const opens = (key: string, settings: Record<string, string>) => {
      const mode = modes.find((candidate) => candidate.key === key);
      if (!mode) throw new Error(`veo-3.1 publishes no ${key} mode`);
      return catalogConditionsMatch(mode.conditions, settings);
    };
    expect(opens('references', { mode: 'veo3_lite', referenceMode: 'elements' })).toBe(true);
    expect(opens('references', { mode: 'veo3_fast', referenceMode: 'elements' })).toBe(true);
    expect(opens('references', { mode: 'veo3', referenceMode: 'elements' })).toBe(false);
    for (const mode of ['veo3_lite', 'veo3_fast', 'veo3']) {
      expect(opens('frames', { mode, referenceMode: 'frames' }), mode).toBe(true);
    }
  });

  it('quotes as production will, from the stored descriptor: Lite and Fast with pictures, Quality without', () => {
    expect(quoteRun(run('veo3_lite', 'elements'), times(3, picture)).costCredits).toBe(30);
    expect(quoteRun(run('veo3_fast', 'elements', { resolution: '1080p' }), [picture]).costCredits).toBe(65);
    expect(quoteRun(run('veo3', 'frames'), [startFrame]).costCredits).toBe(250);
    expect(quoteRun(run('veo3', 'frames', { resolution: '1080p' }), [startFrame, endFrame]).costCredits).toBe(255);
    expect(quoteRun(run('veo3', 'frames', { resolution: '4k' })).costCredits).toBe(370);
    // A Quality run that still sends a picture is refused by the closed mode and by the rule.
    expect(refusal(() => quoteRun(run('veo3', 'elements'), [picture]))).toEqual({
      imageReferences: 'Reference images is unavailable with the selected settings.',
      images: 'Reusable references require Veo Lite or Fast.',
    });
    expect(refusal(() => quoteRun(run('veo3_lite', 'elements'), times(4, picture))).imageReferences)
      .toBe('Reference images supports up to 3.');
    expect(refusal(() => quoteRun(run('veo3_fast', 'elements', { aspectRatio: 'Auto' }), [picture])).aspectRatio)
      .toBe('Veo 3.1 renders reference runs at 16:9 or 9:16 only.');
  });

  it('uses only what installed apps already read, so it needs no app release', () => {
    // The descriptor is production's entry with one condition more (above), so only that condition
    // is new to the apps: the shared lists are held for every model by model-catalog-client-parity.
    expect(published.minClientSchemaVersion).toBe(1);
    for (const control of published.controls) {
      expect(CLIENT_RENDERED_CONTROL_TYPES as readonly string[]).toContain(control.type);
    }
    // Both parsers have taken `in` with a list of values since the v2 catalog shipped (2026-07-24),
    // and the native one needs the list non-empty. The app's code in the store builds (from
    // 6d435fb1 and 35d8cb29) keeps this descriptor and opens its pictures on Lite and Fast alone.
    for (const condition of (published.inputModes ?? []).flatMap((mode) => mode.conditions ?? [])) {
      expect(['equals', 'in']).toContain(condition.operator);
      if (condition.operator === 'in') expect(Array.isArray(condition.value) && condition.value.length > 0).toBe(true);
    }
  });

  it('still refuses a Quality run from an app that counts its pictures without a slot', () => {
    // The app's code before the run's shape was read off the descriptor keeps 'elements' once a
    // picture is attached. On this descriptor its Quality request names no picture slot and still
    // counts the pictures, and the quote refuses it by that count, with the reason it gave before.
    const request = {
      schemaVersion: 2 as const,
      kind: 'video' as const,
      modelId: 'veo-3.1',
      settings: run('veo3', 'elements'),
      inputCounts: { images: 2, videos: 0, audios: 0, preparedAudios: 0, characters: 0 },
      inputMetadata: { slots: {}, referenceVideoDurationsSeconds: [] },
      catalogRevision: catalog.revision,
    };
    expect(refusal(() => quoteGenerationModel(request, { catalog: publishedCatalog, operations: publishedOperations })))
      .toEqual({ images: 'Reusable references require Veo Lite or Fast.' });
  });
});
