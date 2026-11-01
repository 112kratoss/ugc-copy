import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  buildGenerationModelCatalog,
  projectGenerationModelDescriptor,
  quoteGenerationModel,
  type GenerationModelDescriptor,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { parsePublishedModelDescriptor } from '@/lib/generation-model-descriptor-parser';
import {
  buildCodeGenerationModelOperations,
  type GenerationModelOperationalConfig,
} from '@/lib/generation-model-runtime';
import { getMotionCost } from '@/lib/models';
import { referenceMediaMinSeconds, referenceMediaSlotNoun } from '@/lib/provider-input-limits';
import {
  buildUnifiedGenerationQuoteInput,
  buildUnifiedGenerationQuoteInputForCatalog,
  parseUnifiedGenerationRequest,
} from '@/lib/unified-generation-start-service';
import {
  CLIENT_RENDERED_CONTROL_TYPES,
  CLIENT_RENDERED_INPUT_MODE_KEYS,
  CLIENT_RENDERED_INPUT_SLOT_KINDS,
  CLIENT_RENDERED_INPUT_SLOT_ROLES,
  catalogMotionInputSlots,
  catalogRunQuoteInput,
} from '../../ugc-mobile/lib/model-catalog/protocol';
import productionMotion from '../../contracts/production-motion-descriptors-v1.json';
import { validateCatalogManifest } from '../../scripts/ops/generation-model-catalog';

import productionKling3 from './fixtures/production-kling-3-motion-entry-2026-11-01.json';

/**
 * Release 2026-11-01-kling-3-motion-inputs: Kling 3.0 motion, which production served as the
 * compatibility release wrote it (one `default` mode of plain reference slots, `imageReferences` and
 * `videoReferences` with no lengths, on the motion-v1 pricing and validation strategies), re-emitted
 * from the code build: the `motion-inputs` slots Kling 2.6 already publishes (`characterImage`,
 * `referenceVideo` with the 3 s shortest clip the start refuses by and the 30 s cap), per-second
 * pricing and descriptor rules. Every run the creators, the starts and the workflow runner send
 * quotes as before. Two runs are refused at the quote now: one missing its picture or its clip, which
 * the start refused before any hold, and one whose quote names a clip over 30 s, which the start
 * refused once it measured the clip (its duration then passes 30). Neither creator sends either.
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

const manifest = read('2026-11-01-kling-3-motion-inputs.json');
const base = read('2026-10-31-slot-min-durations.json');
const ID = 'kling-3.0';

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operation = buildCodeGenerationModelOperations().find((candidate) => candidate.modelId === ID)!;
const released = manifest.entries.find((entry) => entry.modelId === ID)!;
/** Production's row until this release, read from the active release (the fixture says when). */
const previous = productionKling3.entry as unknown as ManifestEntry;

/** An entry of a release of `schemaVersion` as production's catalog store reads it back, and quotes with it. */
function asProductionReadsIt(entry: ManifestEntry, schemaVersion: number) {
  const descriptor = projectGenerationModelDescriptor(parsePublishedModelDescriptor(
    entry.publicDescriptor,
    entry.modelId,
    schemaVersion,
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
  const server = {
    catalog: { ...catalog, models: catalog.models.map((model) => (model.id === entry.modelId ? descriptor : model)) },
    operations: new Map([[entry.modelId, runtime]]),
  };
  return {
    descriptor,
    /** Where the shared motion rule puts a run's picture and clip on this entry. */
    slots: catalogMotionInputSlots(descriptor, {}),
    /** The run's price, or the quote's refusal by field; anything else the quote throws fails the test. */
    quote: (input: Omit<GenerationModelQuoteInput, 'catalogRevision'>) => {
      try {
        return quoteGenerationModel({ ...input, catalogRevision: catalog.revision } as GenerationModelQuoteInput, server).costCredits;
      } catch (error) {
        if (error instanceof CatalogError) return { refused: error.fieldErrors };
        throw error;
      }
    },
  };
}

const published = asProductionReadsIt(released, manifest.release.schemaVersion);
const before = asProductionReadsIt(previous, base.release.schemaVersion);
const settingsGrid = ['720p', '1080p'].flatMap((resolution) => ['video', 'image'].flatMap((characterOrientation) => (
  Array.from({ length: 30 }, (_, index) => ({ resolution, characterOrientation, duration: index + 1 }))
)));
const slotsOf = (descriptor: GenerationModelDescriptor) => (descriptor.inputModes ?? []).flatMap((mode) => mode.slots);

describe('kling-3-motion-inputs release', () => {
  it('passes the release CLI’s own checks', () => {
    // Among them, the published minimum is the one the start holds the slot to, on a slot labelled in
    // the start's words (scripts/ops/generation-model-catalog.ts).
    expect(() => validateCatalogManifest(manifest)).not.toThrow();
  });

  it('chains onto the release production is running and changes Kling 3.0 motion only', () => {
    expect(manifest.release.revision).toBe('kling-3-motion-inputs-20261101');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(productionKling3.revision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((entry) => entry.modelId)).toEqual([ID]);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
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

  it('moves production’s entry onto the motion-inputs slots and the declarative strategies, and keeps the rest', () => {
    // Same adapter and routing: the start still runs Kling 3.0 motion through motion-v1.
    for (const key of ['kind', 'webEnabled', 'mobileEnabled', 'adapterKey', 'adapterConfig', 'providerModelMap', 'verificationConfig'] as const) {
      expect(released[key], key).toEqual(previous[key]);
    }
    expect([previous.pricingStrategy, previous.validationStrategy]).toEqual(['motion-v1', 'motion-v1']);
    expect([released.pricingStrategy, released.validationStrategy]).toEqual(['per-second', 'descriptor-rules-v1']);
    // No rule either way: the legacy entry carried none, and the code build has none for Kling 3.0.
    expect(previous.validationConfig).toEqual({});
    expect(released.validationConfig).toEqual({ normalizedDefaults: {}, rules: [] });

    // The descriptor changes in its input modes only.
    const { inputModes: modesBefore, ...restBefore } = previous.publicDescriptor;
    const { inputModes: modesAfter, ...restAfter } = released.publicDescriptor;
    expect(restAfter).toEqual(restBefore);
    expect(modesBefore).toEqual([{
      key: 'default',
      label: 'Default',
      default: true,
      slots: [
        { key: 'imageReferences', label: 'Reference images', kind: 'image', role: 'reference', min: 0, max: 1 },
        { key: 'videoReferences', label: 'Reference videos', kind: 'video', role: 'reference', min: 0, max: 1 },
      ],
    }]);
    expect(modesAfter).toEqual([{
      key: 'motion-inputs',
      label: 'Motion inputs',
      default: true,
      slots: [
        { key: 'characterImage', kind: 'image', role: 'reference', label: 'Character image', min: 1, max: 1 },
        {
          key: 'referenceVideo',
          kind: 'video',
          role: 'reference',
          label: 'Reference video',
          min: 1,
          max: 1,
          durationMetadata: 'optional',
          maxDurationSeconds: 30,
          minDurationSeconds: 3,
        },
      ],
    }]);
  });

  it('quotes every setting at the code price on both entries, in each shape a run is quoted in', () => {
    expect(before.slots).toEqual({ image: 'imageReferences', video: 'videoReferences' });
    expect(published.slots).toEqual({ image: 'characterImage', video: 'referenceVideo' });
    /** The run of `settings` in each shape its quote takes, its picture and clip in the entry's own slots. */
    const runs = (slots: { image: string; video: string }, settings: (typeof settingsGrid)[number]) => {
      // A clip the start measures and prices at `duration`: Math.max(1, Math.ceil(seconds)).
      const clip = settings.duration - 0.4;
      const named = (durationSeconds?: number) => catalogRunQuoteInput({
        kind: 'motion',
        modelId: ID,
        catalogRevision: catalog.revision,
        settings,
        inputs: [{ slot: slots.image, kind: 'image' }, { slot: slots.video, kind: 'video', durationSeconds }],
      });
      // The run the unified start is posted, the clip as it measured it.
      const started = parseUnifiedGenerationRequest({
        kind: 'motion',
        modelId: ID,
        catalogRevision: catalog.revision,
        settings,
        prompt: '',
        inputs: [
          { slot: slots.image, kind: 'image', url: 'https://cdn.example.com/hero.png' },
          { slot: slots.video, kind: 'video', url: 'https://cdn.example.com/dance.mp4', durationSeconds: clip },
        ],
      });
      return {
        // The web motion page: each input in its slot, no length.
        web: named(),
        // The app: the same, with the clip's length.
        app: named(clip),
        // The unified start's own quote of the run it charges, on a schema-2 catalog.
        start: buildUnifiedGenerationQuoteInput(started),
        // A schema-1 quote: kind totals and the clip's length, the shape a schema-1 catalog gives the
        // start's run. The quote route reads a request that names no schema version as schema 1, and
        // the store validates a schema-1 quote against the full descriptor (quoteWithSnapshotLoader),
        // as this does.
        schema1Quote: buildUnifiedGenerationQuoteInputForCatalog(
          started,
          { catalog: { schemaVersion: 1 } } as Parameters<typeof buildUnifiedGenerationQuoteInputForCatalog>[1],
        ),
        // The workflow runner's motion step and the legacy motion route: kind totals alone.
        kindTotals: { kind: 'motion' as const, modelId: ID, settings, inputCounts: { images: 1, videos: 1, audios: 0 } },
      };
    };
    expect(settingsGrid).toHaveLength(120);
    for (const settings of settingsGrid) {
      const cost = getMotionCost(ID, settings.resolution as '720p' | '1080p', settings.duration);
      for (const [side, entry] of [['production', before], ['release', published]] as const) {
        for (const [shape, run] of Object.entries(runs(entry.slots, settings))) {
          expect(entry.quote(run), `${side} ${shape} ${JSON.stringify(settings)}`).toBe(cost);
        }
      }
    }
  });

  it('refuses at the quote a run missing its picture or its clip, which production’s entry left to the start', () => {
    // The start refused such a run before any hold either way ("Motion generation requires a character
    // image and reference video."), and both creators hold it before Generate.
    const settings = { resolution: '720p', characterOrientation: 'video', duration: 10 };
    const run = (side: typeof published, inputs: Array<'image' | 'video'>) => side.quote(catalogRunQuoteInput({
      kind: 'motion',
      modelId: ID,
      catalogRevision: catalog.revision,
      settings,
      inputs: inputs.map((kind) => ({ slot: side.slots[kind], kind })),
    }));
    expect(run(before, ['image'])).toEqual(expect.any(Number));
    expect(run(before, ['video'])).toEqual(expect.any(Number));
    expect(run(published, ['image'])).toEqual({ refused: { referenceVideo: 'Reference video requires at least 1.' } });
    expect(run(published, ['video'])).toEqual({ refused: { characterImage: 'Character image requires at least 1.' } });
    expect(run(published, ['image', 'video'])).toEqual(run(before, ['image', 'video']));
  });

  it('serves the shortest clip the start refuses by, on a slot labelled in the start’s words', () => {
    const clipSlots = slotsOf(published.descriptor).filter((slot) => slot.minDurationSeconds !== undefined);
    expect(clipSlots.map((slot) => slot.key)).toEqual(['referenceVideo']);
    expect(clipSlots[0].minDurationSeconds).toBe(referenceMediaMinSeconds(ID, 'motion'));
    expect(clipSlots[0].label.toLowerCase()).toBe(referenceMediaSlotNoun('motion', 'referenceVideo', 'video'));
    // Production's entry published none: the start alone held a short clip, at Generate.
    expect(slotsOf(before.descriptor).some((slot) => slot.minDurationSeconds !== undefined)).toBe(false);
  });

  it('keeps the client schema version and publishes only what installed apps render', () => {
    // The store builds draw the motion pickers by the motion-inputs names, and the newer apps place
    // their inputs by the shared motion rule; each build's own parser keeps this descriptor
    // (archive/kling-3-motion-inputs-2026-11-01/, "Installed apps").
    expect(published.descriptor.minClientSchemaVersion).toBe(before.descriptor.minClientSchemaVersion);
    for (const control of published.descriptor.controls) {
      expect(CLIENT_RENDERED_CONTROL_TYPES as readonly string[]).toContain(control.type);
    }
    for (const mode of published.descriptor.inputModes ?? []) {
      expect(CLIENT_RENDERED_INPUT_MODE_KEYS as readonly string[]).toContain(mode.key);
      for (const slot of mode.slots) {
        expect(CLIENT_RENDERED_INPUT_SLOT_KINDS as readonly string[]).toContain(slot.kind);
        expect(CLIENT_RENDERED_INPUT_SLOT_ROLES as readonly string[]).toContain(slot.role);
      }
    }
  });

  it('is the Kling 3.0 the production motion contract gives both suites', () => {
    // contracts/production-motion-descriptors-v1.json names this release: its Kling 3.0 must be this
    // entry as the server serves it (the published row read back, the schema-3 projection, no
    // `inputs`), and its rollback member production's entry before it, served the same way.
    const served = (entry: ManifestEntry, schemaVersion: number) => {
      const descriptor = projectGenerationModelDescriptor(parsePublishedModelDescriptor(
        entry.publicDescriptor,
        entry.modelId,
        schemaVersion,
        { web: entry.webEnabled, mobile: entry.mobileEnabled },
      ), 3) as unknown as Record<string, unknown>;
      delete descriptor.inputs;
      return descriptor;
    };
    expect(productionMotion.revision).toBe(manifest.release.revision);
    expect(productionMotion.models.find((model) => model.id === ID)).toEqual(served(released, manifest.release.schemaVersion));
    expect(productionMotion.rollback.revision).toBe(base.release.revision);
    expect(productionMotion.rollback.models.find((model) => model.id === ID)).toEqual(served(previous, base.release.schemaVersion));
  });
});
