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
import { IMAGE_MODELS, getImageCost } from '@/lib/models';
import {
  buildUnifiedGenerationQuoteInput,
  parseUnifiedGenerationRequest,
} from '@/lib/unified-generation-start-service';
import {
  CLIENT_RENDERED_CONTROL_TYPES,
  CLIENT_RENDERED_INPUT_MODE_KEYS,
  CLIENT_RENDERED_INPUT_SLOT_KINDS,
  CLIENT_RENDERED_INPUT_SLOT_ROLES,
  catalogRunQuoteInput,
} from '../../ugc-mobile/lib/model-catalog/protocol';
import { validateCatalogManifest } from '../../scripts/ops/generation-model-catalog';

import productionImageEntries from './fixtures/production-image-entries-2026-11-01.json';

/**
 * Release 2026-11-01-image-models-reemit: eight image models production served from entries no release
 * had re-emitted since the code build moved on, re-emitted from the code build.
 *
 * Grok Imagine, Ideogram V3, Seedream 5 Lite and 5 Pro, and Wan 2.7 Image and Image Pro kept the shape
 * the July compatibility release wrote: one `default` input mode, the image-v1 pricing and validation
 * strategies, and no rules. Their image-v1 pricing config is the code's IMAGE_MODELS entry (key order
 * aside), which the runtime rebuilt into the expression the code build now publishes, so every run is
 * priced as before. They publish the same reference slot in a `references` mode, and normalize the
 * output format and Google search the image start already defaulted to. One run moves: Wan 2.7 Image
 * Pro at 4K with a reference picture, which production priced and its start refused before any hold,
 * is refused at the quote in the start's words.
 *
 * Qwen Image 3.0 and 3.0 Pro drop the price rows for 4 to 10 reference pictures, left in their table
 * when enhancer-reference-caps-20260824 capped them at 3; no run could reach those rows.
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

const manifest = read('2026-11-01-image-models-reemit.json');
const base = read('2026-10-31-slot-min-durations.json');

const LEGACY_IDS = ['grok-imagine-image', 'ideogram-v3', 'seedream-5-lite', 'seedream-5-pro', 'wan-2.7-image', 'wan-2.7-image-pro'];
const QWEN_IDS = ['qwen3', 'qwen3-pro'];
const MODEL_IDS = [...LEGACY_IDS, ...QWEN_IDS];
const WAN_PRO_4K_REFUSAL = 'Wan 2.7 Image Pro supports 4K for text-to-image only.';

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();
const released = (modelId: string) => manifest.entries.find((entry) => entry.modelId === modelId)!;
/** Production's row until this release, read from the active release (the fixture says when). */
const previous = (modelId: string) => (productionImageEntries.entries as unknown as ManifestEntry[])
  .find((entry) => entry.modelId === modelId)!;

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
  const run = (input: Omit<GenerationModelQuoteInput, 'catalogRevision'>) => {
    try {
      return quoteGenerationModel({ ...input, catalogRevision: catalog.revision } as GenerationModelQuoteInput, server);
    } catch (error) {
      if (error instanceof CatalogError) return { refused: error.fieldErrors };
      throw error;
    }
  };
  return {
    descriptor,
    run,
    /** The run's price, or the quote's refusal by field; anything else the quote throws fails the test. */
    quote: (input: Omit<GenerationModelQuoteInput, 'catalogRevision'>) => {
      const result = run(input);
      return 'refused' in result ? result : result.costCredits;
    },
  };
}

type Settings = Record<string, string | number | boolean>;

/** Every combination of the values the descriptor's controls offer. */
function settingsGrid(descriptor: GenerationModelDescriptor): Settings[] {
  let grid: Settings[] = [{}];
  for (const control of descriptor.controls) {
    expect(control.type, `${descriptor.id} ${control.key}`).toBe('choice');
    const values = control.type === 'choice' ? control.options.map((option) => option.value) : [];
    grid = grid.flatMap((settings) => values.map((value) => ({ ...settings, [control.key]: value })));
  }
  return grid;
}

const slotsOf = (descriptor: GenerationModelDescriptor) => (descriptor.inputModes ?? []).flatMap((mode) => mode.slots);
const pictures = (count: number) => Array.from({ length: count }, () => ({ slot: 'imageReferences', kind: 'image' as const }));

/** The shapes an image run is quoted in, each read with `count` reference pictures. */
const QUOTE_SHAPES: Array<[string, (modelId: string, settings: Settings, count: number) => Omit<GenerationModelQuoteInput, 'catalogRevision'>]> = [
  // Both creators and the batch quote: the pictures in the imageReferences slot.
  ['creators', (modelId, settings, count) => catalogRunQuoteInput({
    kind: 'image', modelId, catalogRevision: catalog.revision, settings, inputs: pictures(count),
  })],
  // The unified start's own quote of the run it is posted.
  ['unified start', (modelId, settings, count) => buildUnifiedGenerationQuoteInput(parseUnifiedGenerationRequest({
    kind: 'image',
    modelId,
    catalogRevision: catalog.revision,
    settings,
    prompt: 'A lighthouse at dusk',
    inputs: Array.from({ length: count }, (_, index) => ({
      slot: 'imageReferences', kind: 'image', url: `https://cdn.example.com/reference-${index}.png`,
    })),
  }))],
  // The start's quote for a schema-1 catalog, which carries no slots (buildUnifiedGenerationQuoteInputForCatalog).
  ['schema-1 start', (modelId, settings, count) => ({
    ...catalogRunQuoteInput({ kind: 'image', modelId, catalogRevision: catalog.revision, settings, inputs: pictures(count) }),
    schemaVersion: 1,
    inputMetadata: { referenceVideoDurationsSeconds: [] },
  }) as unknown as Omit<GenerationModelQuoteInput, 'catalogRevision'>],
  // The legacy image route (startImageGenerationForRoute): its setting defaults and kind totals.
  ['legacy route', (modelId, settings, count) => ({
    kind: 'image',
    modelId,
    settings: {
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution ?? '1K',
      qualityMode: settings.qualityMode ?? 'standard',
      outputFormat: settings.outputFormat ?? 'jpg',
      googleSearch: false,
    },
    inputCounts: { images: count, videos: 0, audios: 0 },
  })],
  // A workflow canvas's image step: no quality mode, kind totals.
  ['workflow step', (modelId, settings, count) => ({
    kind: 'image',
    modelId,
    settings: {
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution,
      outputFormat: settings.outputFormat ?? 'jpg',
      googleSearch: false,
    },
    inputCounts: { images: count, videos: 0, audios: 0 },
  })],
];

describe('image-models-reemit release', () => {
  it('passes the release CLI’s own checks', () => {
    expect(() => validateCatalogManifest(manifest)).not.toThrow();
  });

  it('chains onto the release production is running and changes the eight models only', () => {
    expect(manifest.release.revision).toBe('image-models-reemit-20261101');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(productionImageEntries.revision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((entry) => entry.modelId)).toEqual(MODEL_IDS);
    expect(productionImageEntries.entries.map((entry) => entry.modelId)).toEqual(MODEL_IDS);
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
    expect(entry.kind).toBe('image');
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
    expect(passthroughSettingKeys).toEqual([]);
    expect(entry.validationConfig).toEqual(validationConfig);
    expect(entry.verificationConfig).toEqual(operation.verificationConfig);
  });

  it.each(MODEL_IDS)('%s keeps production’s adapter, routing and availability', (modelId) => {
    const entry = released(modelId);
    for (const key of ['kind', 'webEnabled', 'mobileEnabled', 'adapterKey', 'adapterConfig', 'providerModelMap', 'verificationConfig'] as const) {
      expect(entry[key], key).toEqual(previous(modelId)[key]);
    }
  });

  it.each(LEGACY_IDS)('%s moves from the compatibility shape to the declarative strategies and a references mode', (modelId) => {
    const before = previous(modelId);
    const entry = released(modelId);
    expect([before.pricingStrategy, before.validationStrategy]).toEqual(['image-v1', 'image-v1']);
    expect(before.validationConfig).toEqual({});
    expect(entry.pricingStrategy).toBe(modelId === 'grok-imagine-image' ? 'conditional' : 'lookup');
    expect(entry.validationStrategy).toBe('descriptor-rules-v1');
    expect(entry.validationConfig).toEqual({
      normalizedDefaults: { outputFormat: 'jpg', googleSearch: false },
      rules: modelId === 'wan-2.7-image-pro'
        ? [expect.objectContaining({ type: 'forbidden-combination', field: 'resolution', message: WAN_PRO_4K_REFUSAL })]
        : [],
    });
    // The runtime prices an image-v1 row by rebuilding the code's expression from the stored model, and
    // the stored model is the code's (key order aside), so the two strategies price alike.
    expect(before.pricingConfig).toEqual(IMAGE_MODELS[modelId as keyof typeof IMAGE_MODELS]);

    // The descriptor changes in its input mode's key and label only: the same slot, cap and naming.
    const { inputModes: modesBefore, ...restBefore } = before.publicDescriptor;
    const { inputModes: modesAfter, ...restAfter } = entry.publicDescriptor;
    expect(restAfter).toEqual(restBefore);
    const [modeBefore] = modesBefore as Array<Record<string, unknown>>;
    expect(modesBefore).toEqual([{ ...modeBefore, key: 'default', label: 'Default', default: true }]);
    expect(modesAfter).toEqual([{ ...modeBefore, key: 'references', label: 'Reference images', default: true }]);
    expect((modeBefore.slots as Array<Record<string, unknown>>).map((slot) => slot.key)).toEqual(['imageReferences']);
  });

  it.each(QWEN_IDS)('%s drops only the price rows its 3-picture cap refuses', (modelId) => {
    const before = previous(modelId);
    const entry = released(modelId);
    const { pricingConfig: configBefore, ...restBefore } = before;
    const { pricingConfig: configAfter, ...restAfter } = entry;
    expect(restAfter).toEqual(restBefore);
    const tableBefore = configBefore.table as Record<string, Record<string, number>>;
    const tableAfter = configAfter.table as Record<string, Record<string, number>>;
    expect({ ...configAfter, table: undefined }).toEqual({ ...configBefore, table: undefined });
    expect(Object.keys(tableAfter)).toEqual(Object.keys(tableBefore));
    for (const [resolution, row] of Object.entries(tableBefore)) {
      const kept = ['0', '1', '2', '3'];
      expect(Object.keys(row), resolution).toEqual([...kept, '4', '5', '6', '7', '8', '9', '10']);
      expect(tableAfter[resolution], resolution).toEqual(Object.fromEntries(kept.map((count) => [count, row[count]])));
    }
    const { descriptor } = asProductionReadsIt(entry, manifest.release.schemaVersion);
    expect(slotsOf(descriptor).map((slot) => [slot.key, slot.max])).toEqual([['imageReferences', 3]]);
    expect(descriptor.inputs.imageReferences?.max).toBe(3);
  });

  it.each(MODEL_IDS)('%s quotes every setting and picture count as production’s entry did', (modelId) => {
    const published = asProductionReadsIt(released(modelId), manifest.release.schemaVersion);
    const before = asProductionReadsIt(previous(modelId), base.release.schemaVersion);
    const grid = settingsGrid(published.descriptor);
    expect(grid.length).toBe(settingsGrid(before.descriptor).length);
    const cap = Math.max(...slotsOf(published.descriptor).map((slot) => slot.max));
    let priced = 0;
    for (const settings of grid) {
      for (let count = 0; count <= cap + 1; count += 1) {
        for (const [shape, build] of QUOTE_SHAPES) {
          const input = build(modelId, settings, count);
          const label = `${shape} ${JSON.stringify(settings)} with ${count} picture(s)`;
          const after = published.quote(input);
          const wanPro4kWithPictures = modelId === 'wan-2.7-image-pro' && input.settings?.resolution === '4K' && count > 0;
          if (!wanPro4kWithPictures) {
            expect(after, label).toEqual(before.quote(input));
          } else {
            // The one run that moves (the case below).
            expect(after, label).toEqual({ refused: expect.objectContaining({ resolution: WAN_PRO_4K_REFUSAL }) });
          }
          if (typeof after === 'number') {
            priced += 1;
            expect(after, label).toBe(Math.ceil(getImageCost(
              modelId as keyof typeof IMAGE_MODELS,
              String(input.settings?.resolution ?? '1K') as never,
              { qualityMode: input.settings?.qualityMode as never, referenceCount: count },
            )));
          }
        }
      }
    }
    expect(priced).toBeGreaterThan(0);
  });

  it('refuses Wan 2.7 Image Pro at 4K with a reference picture at the quote, which the start refused before any hold', () => {
    const published = asProductionReadsIt(released('wan-2.7-image-pro'), manifest.release.schemaVersion);
    const before = asProductionReadsIt(previous('wan-2.7-image-pro'), base.release.schemaVersion);
    const run = (resolution: string, count: number) => catalogRunQuoteInput({
      kind: 'image', modelId: 'wan-2.7-image-pro', catalogRevision: catalog.revision, settings: { aspectRatio: 'auto', resolution }, inputs: pictures(count),
    });
    // Production priced it; startImageGeneration refuses it in these words before it holds credits.
    expect(typeof before.quote(run('4K', 1))).toBe('number');
    expect(published.quote(run('4K', 1))).toEqual({ refused: { resolution: WAN_PRO_4K_REFUSAL } });
    expect(published.quote(run('4K', 9))).toEqual({ refused: { resolution: WAN_PRO_4K_REFUSAL } });
    // Text-only 4K, and pictures at 1K and 2K, are priced as before.
    for (const [resolution, count] of [['4K', 0], ['1K', 1], ['2K', 9]] as const) {
      expect(published.quote(run(resolution, count)), `${resolution} ${count}`).toBe(before.quote(run(resolution, count)));
    }
  });

  it.each(LEGACY_IDS)('%s normalizes only the output format and Google search the image start defaults to', (modelId) => {
    // startImageGeneration takes outputFormat 'jpg' when a run names none, the unified start reads
    // googleSearch as `=== true`, and neither model family offers either one as a control here but
    // Seedream's output format, so the provider is sent what it was sent before.
    const published = asProductionReadsIt(released(modelId), manifest.release.schemaVersion);
    const before = asProductionReadsIt(previous(modelId), base.release.schemaVersion);
    const input = catalogRunQuoteInput({ kind: 'image', modelId, catalogRevision: catalog.revision, settings: {}, inputs: pictures(1) });
    const after = published.run(input);
    const earlier = before.run(input);
    if ('refused' in after || 'refused' in earlier) throw new Error(`${modelId} refused its defaults`);
    const offersOutputFormat = published.descriptor.controls.some((control) => control.key === 'outputFormat');
    expect(after.normalizedSettings).toEqual({
      ...earlier.normalizedSettings,
      ...(offersOutputFormat ? {} : { outputFormat: 'jpg' }),
      googleSearch: false,
    });
    expect(earlier.normalizedSettings.googleSearch).toBeUndefined();
  });

  it.each(LEGACY_IDS)('%s publishes only what both creators and the installed apps render', (modelId) => {
    // The store builds' parsers and every OTA since kept all six on both shapes, and sent the same quote and
    // run either way (archive/image-models-reemit-2026-11-01/, "Installed apps").
    const published = asProductionReadsIt(released(modelId), manifest.release.schemaVersion);
    const before = asProductionReadsIt(previous(modelId), base.release.schemaVersion);
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
    // Production's `default` mode is not one the creators name: they read its slot by key.
    expect(CLIENT_RENDERED_INPUT_MODE_KEYS as readonly string[]).not.toContain('default');
  });
});
