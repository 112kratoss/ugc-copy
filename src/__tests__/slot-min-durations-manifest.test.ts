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
import { referenceMediaMinSeconds, referenceMediaRole } from '@/lib/provider-input-limits';
import {
  CLIENT_RENDERED_CONTROL_TYPES,
  catalogRunQuoteInput,
  type CatalogRunInputFact,
} from '../../ugc-mobile/lib/model-catalog/protocol';

import { descriptorBeforeSlotMinDurations, SLOT_MIN_DURATION_SLOTS } from './fixtures/slot-min-durations-2026-10-31';

/**
 * Release 2026-10-31-slot-min-durations: the clip and track slots whose files the start holds to
 * Kie's shortest publish it, `minDurationSeconds` on the slot (2 s on the Seedance 2 family's and
 * MiniMax H3's clips and tracks, 1 s on Wan 3.0 / Prime's and on Wan 2.7's tracks, 3 s on Kling
 * 2.6's motion clip). The start already refused a shorter file before any hold
 * (src/lib/provider-input-limits.ts), but the creator learned it only once Generate was pressed;
 * the creators now hold the run to the published minimum before Generate. Each entry must equal
 * the code build, and adds those keys to production's entry. Kling 3.0 motion stays out: production
 * keeps its compatibility descriptor, and re-emitting it would also move its pricing and
 * validation off motion-v1.
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

const manifest = read('2026-10-31-slot-min-durations.json');
const base = read('2026-10-30-kling-element-min-duration.json');

/** Production's entry for each model until this release: the last release that carried it. */
const PREVIOUS_RELEASE: Record<string, string> = {
  'seedance-2': '2026-09-04-reference-audit.json',
  'seedance-2-fast': '2026-10-20-kie-checkup.json',
  'seedance-2-mini': '2026-10-28-mini-default-video.json',
  'seedance-2-5': '2026-10-20-kie-checkup.json',
  'minimax-h3': '2026-10-20-kie-checkup.json',
  'wan-2.7': '2026-10-20-kie-checkup.json',
  'wan-3.0': '2026-10-08-kie-video-models.json',
  'wan-3.0-prime': '2026-10-08-kie-video-models.json',
  'kling-2.6': '2026-09-04-reference-audit.json',
};
const MODEL_IDS = Object.keys(PREVIOUS_RELEASE);

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();
const released = (modelId: string) => manifest.entries.find((entry) => entry.modelId === modelId)!;
const previous = (modelId: string) => read(PREVIOUS_RELEASE[modelId]).entries.find((entry) => entry.modelId === modelId)!;

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
    /** The run's price, or the quote's refusal in its words. */
    quote: (settings: Record<string, string | number | boolean>, inputs: CatalogRunInputFact[]) => {
      try {
        return quoteGenerationModel(
          catalogRunQuoteInput({ kind: entry.kind, modelId: entry.modelId, catalogRevision: catalog.revision, settings, inputs }),
          {
            catalog: { ...catalog, models: catalog.models.map((model) => (model.id === entry.modelId ? descriptor : model)) },
            operations: new Map([[entry.modelId, operation]]),
          },
        ).costCredits;
      } catch (error) {
        return `refused: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

const slotsOf = (descriptor: GenerationModelDescriptor) => (descriptor.inputModes ?? []).flatMap((mode) => mode.slots);

describe('slot-min-durations release', () => {
  it('chains onto the release production is running and changes the nine models only', () => {
    expect(manifest.release.revision).toBe('slot-min-durations-20261031');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((entry) => entry.modelId).sort()).toEqual([...MODEL_IDS].sort());
    // Every model whose code build gains a minimum, but Kling 3.0 motion (see above).
    expect(Object.keys(SLOT_MIN_DURATION_SLOTS).filter((id) => !MODEL_IDS.includes(id))).toEqual(['kling-3.0']);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
    expect(manifest.defaults).toEqual(base.defaults);
  });

  it.each(MODEL_IDS)('%s is the code build', (modelId) => {
    const entry = released(modelId);
    const operation = operations.find((candidate) => candidate.modelId === modelId)!;
    const { schemaVersion, ...publicDescriptor } = entry.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(catalog.models.find((model) => model.id === modelId));
    expect(entry.webEnabled).toBe(true);
    expect(entry.mobileEnabled).toBe(true);
    expect(entry.adapterKey).toBe(operation.adapterKey);
    expect(entry.adapterConfig).toEqual(operation.adapterConfig);
    expect(entry.providerModelMap).toEqual(operation.providerModelMap);
    expect(entry.pricingStrategy).toBe(operation.pricingStrategy);
    expect(entry.pricingConfig).toEqual(operation.pricingConfig);
    expect(entry.validationStrategy).toBe(operation.validationStrategy);
    // The emitter drops an empty passthroughSettingKeys, which the runtime reads as absent.
    const { passthroughSettingKeys, ...validationConfig } = operation.validationConfig as Record<string, unknown>;
    expect(entry.validationConfig).toEqual(
      Array.isArray(passthroughSettingKeys) && passthroughSettingKeys.length > 0
        ? { ...validationConfig, passthroughSettingKeys }
        : validationConfig,
    );
  });

  it.each(MODEL_IDS)('%s adds the shortest clip or track to production’s entry, and nothing else', (modelId) => {
    // The fixture the earlier release tests read today's build through, against production's entry.
    const entry = released(modelId);
    expect({
      ...entry,
      publicDescriptor: descriptorBeforeSlotMinDurations(entry.publicDescriptor as unknown as GenerationModelDescriptor),
    }).toEqual(previous(modelId));
  });

  it.each(MODEL_IDS)('%s serves the minimums the start refuses by, once production reads the row back', (modelId) => {
    const { descriptor } = asProductionReadsIt(released(modelId));
    const withMinimum = slotsOf(descriptor).filter((slot) => slot.minDurationSeconds !== undefined);
    expect(withMinimum.map((slot) => slot.key)).toEqual(SLOT_MIN_DURATION_SLOTS[modelId]);
    for (const slot of withMinimum) {
      expect(slot.minDurationSeconds, slot.key)
        .toBe(referenceMediaMinSeconds(modelId, referenceMediaRole(descriptor.kind, slot.key, slot.kind as 'video' | 'audio')));
    }
  });

  it.each(MODEL_IDS)('%s quotes every run as production’s entry did', (modelId) => {
    const published = asProductionReadsIt(released(modelId));
    const before = asProductionReadsIt(previous(modelId));
    const settings: Record<string, string | number | boolean> = Object.fromEntries(
      published.descriptor.controls.map((control) => [control.key, control.defaultValue]),
    );
    if (published.descriptor.controls.some((control) => control.key === 'referenceMode')) settings.referenceMode = 'elements';
    const runs: CatalogRunInputFact[][] = published.descriptor.kind === 'motion'
      ? [2.1, 3, 8].map((seconds) => [
          { slot: 'characterImage', kind: 'image' },
          { slot: 'referenceVideo', kind: 'video', durationSeconds: seconds },
        ])
      // The quote prices a file shorter than the minimum as before: the creators hold the run, and
      // the start refuses it before any hold, with the measured length.
      : [0.5, 1.5, 4].flatMap((seconds) => {
        const media = slotsOf(published.descriptor).filter((slot) => slot.kind === 'video' || slot.kind === 'audio');
        const fact = (slot: (typeof media)[number], durationSeconds: number): CatalogRunInputFact => (
          { slot: slot.key, kind: slot.kind as 'video' | 'audio', durationSeconds }
        );
        const clip = media.find((slot) => slot.kind === 'video');
        return [
          ...media.map((slot) => [fact(slot, seconds)]),
          // A track beside a clip: MiniMax H3 and Wan 2.7 price a track only with one.
          ...(clip ? media.filter((slot) => slot.kind === 'audio').map((slot) => [fact(clip, 4), fact(slot, seconds)]) : []),
        ];
      });
    expect(runs.length).toBeGreaterThan(0);
    for (const inputs of runs) {
      expect(published.quote(settings, inputs), JSON.stringify(inputs)).toBe(before.quote(settings, inputs));
    }
  });

  it.each(MODEL_IDS)('%s uses only what installed apps already read, so it needs no app release', (modelId) => {
    // One optional slot key more, on slots the apps already draw. The store builds' parsers rebuild a
    // slot from the keys they know and keep these descriptors whole, without the minimum
    // (archive/slot-min-durations-2026-10-31/, "Installed apps on the release").
    const published = asProductionReadsIt(released(modelId));
    const before = asProductionReadsIt(previous(modelId));
    expect(published.descriptor.minClientSchemaVersion).toBe(before.descriptor.minClientSchemaVersion);
    for (const control of published.descriptor.controls) {
      expect(CLIENT_RENDERED_CONTROL_TYPES as readonly string[]).toContain(control.type);
    }
  });
});
