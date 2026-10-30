import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
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
import { referenceMediaMinSeconds } from '@/lib/provider-input-limits';
import {
  CLIENT_RENDERED_CONTROL_TYPES,
  catalogRunQuoteInput,
  type CatalogRunInputFact,
} from '../../ugc-mobile/lib/model-catalog/protocol';

import { descriptorBeforeKlingElementMinimum } from './fixtures/kling-element-min-duration-2026-10-30';

/**
 * Release 2026-10-30-kling-element-min-duration: Kling 3.0's video elements publish the shortest
 * clip Kie takes, `minDurationSeconds: 3` on the `videoElements` slot (kling-3.0/video: a video
 * element's "duration must be at least 3 seconds"). The start already refused a shorter clip
 * before any hold (src/lib/provider-input-limits.ts), but the creator learned it only once
 * Generate was pressed; both creators now hold the run to the published minimum before Generate.
 * The entry must equal the code build, and adds that one key to production's entry.
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

const manifest = read('2026-10-30-kling-element-min-duration.json');
const base = read('2026-10-30-veo-quality-references.json');
// Production's entry until this release: the last release that carried Kling 3.0.
const previous = read('2026-10-28-mini-default-video.json').entries.find((entry) => entry.modelId === 'kling-3.0-video')!;

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();
const released = manifest.entries.find((entry) => entry.modelId === 'kling-3.0-video')!;

/** An entry as production's catalog store reads it back, and quotes with it. */
function asProductionReadsIt(entry: ManifestEntry) {
  const descriptor = projectGenerationModelDescriptor(parsePublishedModelDescriptor(
    entry.publicDescriptor,
    entry.modelId,
    manifest.release.schemaVersion,
    { web: entry.webEnabled, mobile: entry.mobileEnabled },
  ), 2);
  const operation: GenerationModelOperationalConfig = {
    modelId: entry.modelId,
    kind: entry.kind,
    adapterKey: entry.adapterKey as GenerationModelOperationalConfig['adapterKey'],
    adapterConfig: entry.adapterConfig,
    providerModelMap: entry.providerModelMap,
    pricingStrategy: entry.pricingStrategy as GenerationModelOperationalConfig['pricingStrategy'],
    pricingConfig: entry.pricingConfig,
    validationStrategy: entry.validationStrategy as GenerationModelOperationalConfig['validationStrategy'],
    validationConfig: entry.validationConfig,
    verificationConfig: entry.verificationConfig,
  };
  return {
    descriptor,
    quote: (settings: Record<string, string | number | boolean>, inputs: CatalogRunInputFact[] = []) => quoteGenerationModel(
      catalogRunQuoteInput({ kind: 'video', modelId: entry.modelId, catalogRevision: catalog.revision, settings, inputs }),
      {
        catalog: { ...catalog, models: catalog.models.map((model) => (model.id === entry.modelId ? descriptor : model)) },
        operations: new Map([[entry.modelId, operation]]),
      },
    ).costCredits,
  };
}

const published = asProductionReadsIt(released);
const before = asProductionReadsIt(previous);
const slotsOf = (descriptor: GenerationModelDescriptor) => (descriptor.inputModes ?? []).flatMap((mode) => mode.slots);

describe('kling-element-min-duration release', () => {
  it('chains onto the release production is running and changes Kling 3.0 only', () => {
    expect(manifest.release.revision).toBe('kling-element-min-duration-20261030');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((entry) => entry.modelId)).toEqual(['kling-3.0-video']);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    expect(manifest.defaults).toEqual(base.defaults);
  });

  it('is the code build', () => {
    const operation = operations.find((candidate) => candidate.modelId === 'kling-3.0-video')!;
    const { schemaVersion, ...publicDescriptor } = released.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(catalog.models.find((model) => model.id === 'kling-3.0-video'));
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

  it('adds the video elements’ shortest clip to production’s entry, and nothing else', () => {
    // The fixture the earlier release tests read today's build through, against production's entry.
    expect({
      ...released,
      publicDescriptor: descriptorBeforeKlingElementMinimum(released.publicDescriptor as unknown as GenerationModelDescriptor),
    }).toEqual(previous);
  });

  it('serves the minimum the start refuses by, once production reads the row back', () => {
    const elements = slotsOf(published.descriptor).find((slot) => slot.key === 'videoElements');
    expect(elements).toMatchObject({ kind: 'video', label: 'Video elements', durationMetadata: 'optional', minDurationSeconds: 3 });
    expect(elements?.minDurationSeconds).toBe(referenceMediaMinSeconds('kling-3.0-video', 'element'));
    expect(slotsOf(published.descriptor).filter((slot) => slot.minDurationSeconds !== undefined)).toEqual([elements]);
  });

  it('quotes every run as production’s entry did', () => {
    const run = (extra: Record<string, string | number | boolean> = {}) => ({
      aspectRatio: '16:9', mode: 'std', duration: 5, sound: false, isMultiShot: false, referenceMode: 'frames', ...extra,
    });
    const clip = (seconds: number): CatalogRunInputFact => ({ slot: 'videoElements', kind: 'video', durationSeconds: seconds });
    const startFrame: CatalogRunInputFact = { slot: 'startFrame', kind: 'image' };
    const runs: Array<[Record<string, string | number | boolean>, CatalogRunInputFact[]]> = [
      [run(), []],
      [run({ mode: 'pro', duration: 10 }), [startFrame]],
      [run({ sound: true }), [startFrame, clip(4)]],
      [run({ duration: 15 }), [clip(3), clip(12)]],
      // The quote prices a clip shorter than the minimum as before: the creators hold the run, and
      // the start refuses it before any hold, with the measured length.
      [run(), [clip(2.1)]],
    ];
    for (const [settings, inputs] of runs) {
      expect(published.quote(settings, inputs), JSON.stringify([settings, inputs])).toBe(before.quote(settings, inputs));
    }
  });

  it('uses only what installed apps already read, so it needs no app release', () => {
    // One optional slot key more. The store builds' parsers (from 6d435fb1 and 35d8cb29) rebuild a
    // slot from the keys they know and keep this descriptor whole, without the minimum
    // (archive/kling-element-min-duration-2026-10-30/, "Installed apps on the release").
    expect(published.descriptor.minClientSchemaVersion).toBe(before.descriptor.minClientSchemaVersion);
    for (const control of published.descriptor.controls) {
      expect(CLIENT_RENDERED_CONTROL_TYPES as readonly string[]).toContain(control.type);
    }
  });
});
