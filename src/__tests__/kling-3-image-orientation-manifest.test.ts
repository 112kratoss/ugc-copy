import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  projectGenerationModelDescriptor,
  quoteGenerationModel,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { parsePublishedModelDescriptor } from '@/lib/generation-model-descriptor-parser';
import {
  buildCodeGenerationModelOperations,
  motionImageOrientationRefusal,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import { getMotionCost } from '@/lib/models';
import { catalogMotionInputSlots, catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import productionMotion from '../../contracts/production-motion-descriptors-v1.json';
import { validateCatalogManifest } from '../../scripts/ops/generation-model-catalog';

import { isImageOrientationCap } from './fixtures/kling-3-image-orientation-2026-11-05';

/**
 * Release 2026-11-05-kling-3-image-orientation: Kling 3.0 motion takes a clip of at most 10 seconds
 * under `character_orientation: image`, as Kling 2.6's has since 2026-09-04. Kie's spec for
 * kling-3.0/motion-control names no cap, but its market page's form says "(max 10s video)", and
 * fal.ai's and Vercel's hosts of the model state the same (re-read 2026-11-01,
 * docs/model-api-references/kling-3.0/kling-3.0/kling-3.0-motion-control.md). The entry moves in its
 * validation rules only: a longer image-oriented run is refused at the quote, and the start refuses
 * it before any hold for callers that skip the quote. Every other run quotes as before.
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

const manifest = read('2026-11-05-kling-3-image-orientation.json');
/** The release production runs, which this one clones. */
const base = read('2026-11-01-image-models-reemit.json');
/** The last release to write Kling 3.0 motion: production's entry until this one. */
const kling3Release = read('2026-11-01-kling-3-motion-inputs.json');
const ID = 'kling-3.0';

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();
const operation = operations.find((candidate) => candidate.modelId === ID)!;
const released = manifest.entries.find((entry) => entry.modelId === ID)!;
const previous = kling3Release.entries.find((entry) => entry.modelId === ID)!;
const REFUSAL = 'Kling 3.0 keeps image orientation to 10 seconds; use video orientation for longer clips.';

/** An entry as production's catalog store reads it back, and quotes with it. */
function asProductionReadsIt(entry: ManifestEntry) {
  const descriptor = projectGenerationModelDescriptor(parsePublishedModelDescriptor(
    entry.publicDescriptor,
    entry.modelId,
    2,
    { web: entry.webEnabled, mobile: entry.mobileEnabled },
  ), 2);
  const runtime: GenerationModelOperationalConfig = {
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
    slots: catalogMotionInputSlots(descriptor, {}),
    /** The run's price, or the quote's refusal by field. */
    quote: (input: Omit<GenerationModelQuoteInput, 'catalogRevision'>) => {
      try {
        return quoteGenerationModel({ ...input, catalogRevision: catalog.revision } as GenerationModelQuoteInput, {
          catalog: { ...catalog, models: catalog.models.map((model) => (model.id === entry.modelId ? descriptor : model)) },
          operations: new Map([[entry.modelId, runtime]]),
        }).costCredits;
      } catch (error) {
        return { refused: (error as { fieldErrors?: Record<string, string> }).fieldErrors ?? String(error) };
      }
    },
  };
}

const published = asProductionReadsIt(released);
const before = asProductionReadsIt(previous);

/**
 * A run in the shapes its callers quote it: its own slots with no length (the web page), with the
 * clip's length (the app, and the start, which prices `duration` from the measured clip), and in kind
 * totals alone (the workflow runner's motion step, the schema-1 starts and the legacy motion route).
 */
function runs(slots: { image: string; video: string }, settings: Record<string, string | number>) {
  const clip = Math.max(0.6, Number(settings.duration) - 0.4);
  const named = (durationSeconds?: number) => catalogRunQuoteInput({
    kind: 'motion',
    modelId: ID,
    catalogRevision: catalog.revision,
    settings,
    inputs: [{ slot: slots.image, kind: 'image' }, { slot: slots.video, kind: 'video', durationSeconds }],
  });
  return [
    named(),
    named(clip),
    {
      kind: 'motion' as const,
      modelId: ID,
      settings,
      inputCounts: { images: 1, videos: 1, audios: 0 },
      inputMetadata: { referenceVideoDurationsSeconds: [clip] },
    },
  ];
}

describe('kling-3-image-orientation release', () => {
  it('passes the release CLI’s own checks', () => {
    expect(() => validateCatalogManifest(manifest)).not.toThrow();
  });

  it('chains onto the release production runs and changes Kling 3.0 motion only', () => {
    // That release left Kling 3.0 motion as kling-3-motion-inputs-20261101 wrote it.
    expect(base.release.basedOnRevision).toBe(kling3Release.release.revision);
    expect(base.entries.map((entry) => entry.modelId)).not.toContain(ID);
    expect(manifest.release.revision).toBe('kling-3-image-orientation-20261105');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((entry) => entry.modelId)).toEqual([ID]);
    expect(manifest.addsModelIds).toBeUndefined();
    expect(manifest.expectedModelIds).toEqual(base.expectedModelIds);
    expect(manifest.defaults).toEqual(base.defaults);
  });

  it('is the code build', () => {
    const { schemaVersion, ...publicDescriptor } = released.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(catalog.models.find((model) => model.id === ID && model.kind === 'motion'));
    expect(released.kind).toBe('motion');
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
    expect(passthroughSettingKeys).toEqual([]);
    expect(released.validationConfig).toEqual(validationConfig);
    expect(released.verificationConfig).toEqual(operation.verificationConfig);
  });

  it('moves the entry it builds on in its validation rules only, by Kling 2.6’s cap', () => {
    for (const key of Object.keys(previous) as Array<keyof ManifestEntry>) {
      if (key !== 'validationConfig') expect(released[key], key).toEqual(previous[key]);
    }
    expect(previous.validationConfig).toEqual({ normalizedDefaults: {}, rules: [] });
    const rules = released.validationConfig.rules as Array<Record<string, unknown>>;
    expect(rules).toEqual([{
      type: 'forbidden-combination',
      conditions: [
        { source: 'setting', key: 'characterOrientation', operator: 'equals', value: 'image' },
        { source: 'setting', key: 'duration', operator: 'greaterThan', value: 10 },
      ],
      field: 'duration',
      message: REFUSAL,
    }]);
    expect(rules.every((rule) => isImageOrientationCap(rule))).toBe(true);
    // The same rule as Kling 2.6's, in its own name; the start refuses in the same words.
    const kling26 = (operations.find((candidate) => candidate.modelId === 'kling-2.6')!.validationConfig.rules as
      Array<Record<string, unknown>>).filter((rule) => isImageOrientationCap(rule));
    expect(kling26).toEqual([{ ...rules[0], message: REFUSAL.replace('Kling 3.0', 'Kling 2.6') }]);
    expect(motionImageOrientationRefusal(ID)).toBe(REFUSAL);
  });

  it('refuses an image-oriented clip over 10 seconds in every shape, and quotes every other run as before', () => {
    expect(published.slots).toEqual({ image: 'characterImage', video: 'referenceVideo' });
    expect(published.slots).toEqual(before.slots);
    const grid = ['720p', '1080p'].flatMap((resolution) => ['video', 'image'].flatMap((characterOrientation) => (
      Array.from({ length: 30 }, (_, index) => ({ resolution, characterOrientation, duration: index + 1 }))
    )));
    expect(grid).toHaveLength(120);
    let refused = 0;
    for (const settings of grid) {
      const label = JSON.stringify(settings);
      const prices = runs(published.slots, settings).map((run) => published.quote(run));
      const pricesBefore = runs(before.slots, settings).map((run) => before.quote(run));
      // The entry it builds on prices every setting, as production's entry did.
      expect(pricesBefore, label).toEqual(Array(3).fill(getMotionCost(ID, settings.resolution as '720p' | '1080p', settings.duration)));
      if (settings.characterOrientation === 'image' && settings.duration > 10) {
        refused += 1;
        expect(prices, label).toEqual(Array(3).fill({ refused: { duration: REFUSAL } }));
      } else {
        expect(prices, label).toEqual(pricesBefore);
      }
    }
    // 2 resolutions × 20 durations (11–30 s) under image orientation.
    expect(refused).toBe(40);
  });

  it('leaves the production motion contract’s Kling 3.0 as the server serves it', () => {
    // No descriptor change: the creators draw the same slots and controls, and both show the quote's
    // refusal as they show Kling 2.6's, so no app build or OTA rides with this release.
    expect(productionMotion.revision).toBe(kling3Release.release.revision);
    const served = projectGenerationModelDescriptor(parsePublishedModelDescriptor(
      released.publicDescriptor,
      ID,
      2,
      { web: released.webEnabled, mobile: released.mobileEnabled },
    ), 3) as unknown as Record<string, unknown>;
    delete served.inputs;
    expect(productionMotion.models.find((model) => model.id === ID)).toEqual(served);
  });
});
