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
import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
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
// Kling 3.0 motion's release, which re-emits that model only, so production's rows for these eight are the ones
// slot-min-durations-20261031 served.
const base = read('2026-11-01-kling-3-motion-inputs.json');

const LEGACY_IDS = ['grok-imagine-image', 'ideogram-v3', 'seedream-5-lite', 'seedream-5-pro', 'wan-2.7-image', 'wan-2.7-image-pro'];
const QWEN_IDS = ['qwen3', 'qwen3-pro'];
const MODEL_IDS = [...LEGACY_IDS, ...QWEN_IDS];
const WAN_PRO_4K_REFUSAL = 'Wan 2.7 Image Pro supports 4K for text-to-image only.';
/** The parts of production's row this release changes: the compatibility shape's, and Qwen's table. */
const CHANGED_KEYS: Record<string, readonly (keyof ManifestEntry)[]> = Object.fromEntries(MODEL_IDS.map((modelId) => [
  modelId,
  QWEN_IDS.includes(modelId)
    ? ['pricingConfig']
    : ['publicDescriptor', 'pricingStrategy', 'pricingConfig', 'validationStrategy', 'validationConfig'],
]));
/** The committed release that last wrote production's row, for the four a committed release carried. */
const LAST_RELEASE: Record<string, string> = {
  'wan-2.7-image': '2026-07-25-wan-provider-id-fix.json',
  'wan-2.7-image-pro': '2026-07-25-wan-provider-id-fix.json',
  qwen3: '2026-08-24-enhancer-reference-caps.json',
  'qwen3-pro': '2026-08-24-enhancer-reference-caps.json',
};
/** The only controls a price or a rule of these entries reads; aspect ratio and output format change neither. */
const PRICED_CONTROL_KEYS = ['resolution', 'qualityMode'];

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();
const released = (modelId: string) => manifest.entries.find((entry) => entry.modelId === modelId)!;
/** Production's row until this release, read from the active release (the fixture says when). */
const previous = (modelId: string) => (productionImageEntries.entries as unknown as ManifestEntry[])
  .find((entry) => entry.modelId === modelId)!;
const omit = (entry: ManifestEntry, keys: readonly string[]) => Object.fromEntries(
  Object.entries(entry).filter(([key]) => !keys.includes(key)),
);

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

/**
 * Every combination of the controls a price or a rule reads, then each value of every other control beside
 * the first of them. Every combination of every control (6,730 quotes in five shapes) was compared before
 * this release (archive/image-models-reemit-2026-11-01/); the grid test holds that no price or rule here
 * reads another control.
 */
function settingsGrid(descriptor: GenerationModelDescriptor): Settings[] {
  const values = (control: GenerationModelDescriptor['controls'][number]) => {
    expect(control.type, `${descriptor.id} ${control.key}`).toBe('choice');
    return control.type === 'choice' ? control.options.map((option) => option.value) : [];
  };
  let grid: Settings[] = [{}];
  for (const control of descriptor.controls.filter((candidate) => PRICED_CONTROL_KEYS.includes(candidate.key))) {
    grid = grid.flatMap((settings) => values(control).map((value) => ({ ...settings, [control.key]: value })));
  }
  const others = descriptor.controls
    .filter((control) => !PRICED_CONTROL_KEYS.includes(control.key))
    .flatMap((control) => values(control).map((value) => ({ ...grid[0], [control.key]: value })));
  return [...grid, ...others];
}

/** Every setting key a pricing expression or a validation rule names. */
function settingKeysRead(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => settingKeysRead(item, keys));
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.source === 'setting' && typeof record.key === 'string') keys.add(record.key);
    Object.values(record).forEach((item) => settingKeysRead(item, keys));
  }
  return keys;
}

const slotsOf = (descriptor: GenerationModelDescriptor) => (descriptor.inputModes ?? []).flatMap((mode) => mode.slots);
const pictures = (count: number) => Array.from({ length: count }, () => ({ slot: 'imageReferences', kind: 'image' as const }));

/**
 * The distinct quotes an image run is priced with, each read with `count` reference pictures. Both creators,
 * the batch quote and the unified start send the named-slot quote (buildUnifiedGenerationQuoteInput is
 * catalogRunQuoteInput). The legacy image route and a workflow canvas step send kind totals, with their own
 * setting defaults; a quote that names no schema version is read as schema 1 and sends the same totals.
 */
const QUOTE_SHAPES: Array<[string, (modelId: string, settings: Settings, count: number) => Omit<GenerationModelQuoteInput, 'catalogRevision'>]> = [
  ['named slots', (modelId, settings, count) => catalogRunQuoteInput({
    kind: 'image', modelId, catalogRevision: catalog.revision, settings, inputs: pictures(count),
  })],
  // startImageGenerationForRoute's setting defaults.
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
  // The workflow runner's image step: the node's settings, no quality mode.
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

  it.each(MODEL_IDS)('%s keeps the rest of production’s row: adapter, routing, availability, verification', (modelId) => {
    expect(omit(released(modelId), CHANGED_KEYS[modelId])).toEqual(omit(previous(modelId), CHANGED_KEYS[modelId]));
  });

  it.each(Object.keys(LAST_RELEASE))('%s was read from production as the last release that carried it wrote it', (modelId) => {
    expect(previous(modelId)).toEqual(read(LAST_RELEASE[modelId]).entries.find((entry) => entry.modelId === modelId));
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

    // The descriptor changes in its input mode's key and label only: the same slot, cap and naming. Neither
    // creator reads a mode's key or label for an image model: both find the slot by its key.
    const { inputModes: modesBefore, ...restBefore } = before.publicDescriptor;
    const { inputModes: modesAfter, ...restAfter } = entry.publicDescriptor;
    expect(restAfter).toEqual(restBefore);
    const [modeBefore] = modesBefore as Array<Record<string, unknown>>;
    expect(modesBefore).toEqual([{ ...modeBefore, key: 'default', label: 'Default', default: true }]);
    expect(modesAfter).toEqual([{ ...modeBefore, key: 'references', label: 'Reference images', default: true }]);
    expect((modeBefore.slots as Array<Record<string, unknown>>).map((slot) => slot.key)).toEqual(['imageReferences']);
  });

  it.each(QWEN_IDS)('%s drops only the price rows its 3-picture cap refuses', (modelId) => {
    const configBefore = previous(modelId).pricingConfig;
    const configAfter = released(modelId).pricingConfig;
    const tableBefore = configBefore.table as Record<string, Record<string, number>>;
    const tableAfter = configAfter.table as Record<string, Record<string, number>>;
    expect({ ...configAfter, table: undefined }).toEqual({ ...configBefore, table: undefined });
    expect(Object.keys(tableAfter)).toEqual(Object.keys(tableBefore));
    for (const [resolution, row] of Object.entries(tableBefore)) {
      const kept = ['0', '1', '2', '3'];
      expect(Object.keys(row), resolution).toEqual([...kept, '4', '5', '6', '7', '8', '9', '10']);
      expect(tableAfter[resolution], resolution).toEqual(Object.fromEntries(kept.map((count) => [count, row[count]])));
    }
    const { descriptor } = asProductionReadsIt(released(modelId), manifest.release.schemaVersion);
    expect(slotsOf(descriptor).map((slot) => [slot.key, slot.max])).toEqual([['imageReferences', 3]]);
    expect(descriptor.inputs.imageReferences?.max).toBe(3);
  });

  it.each(MODEL_IDS)('%s quotes every setting and picture count as production’s entry did', (modelId) => {
    const entry = released(modelId);
    const published = asProductionReadsIt(entry, manifest.release.schemaVersion);
    const before = asProductionReadsIt(previous(modelId), base.release.schemaVersion);
    // What lets the grid leave aspect ratio and output format uncrossed.
    expect([...settingKeysRead([entry.pricingConfig, entry.validationConfig])]
      .filter((key) => !PRICED_CONTROL_KEYS.includes(key))).toEqual([]);
    const cap = Math.max(...slotsOf(published.descriptor).map((slot) => slot.max));
    let priced = 0;
    for (const settings of settingsGrid(published.descriptor)) {
      for (let count = 0; count <= cap + 1; count += 1) {
        for (const [shape, build] of QUOTE_SHAPES) {
          const input = build(modelId, settings, count);
          const label = `${shape} ${JSON.stringify(settings)} with ${count} picture(s)`;
          const after = published.quote(input);
          if (modelId === 'wan-2.7-image-pro' && input.settings?.resolution === '4K' && count > 0) {
            // The one run that moves: production priced it up to the cap; the release refuses it.
            if (count <= cap) expect(typeof before.quote(input), label).toBe('number');
            expect(after, label).toEqual({ refused: expect.objectContaining({ resolution: WAN_PRO_4K_REFUSAL }) });
          } else {
            expect(after, label).toEqual(before.quote(input));
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

  it('refuses Wan 2.7 Image Pro at 4K with a reference picture at the quote, in the words the start refused it with', () => {
    const published = asProductionReadsIt(released('wan-2.7-image-pro'), manifest.release.schemaVersion);
    const run = (count: number) => catalogRunQuoteInput({
      kind: 'image', modelId: 'wan-2.7-image-pro', catalogRevision: catalog.revision, settings: { aspectRatio: 'auto', resolution: '4K' }, inputs: pictures(count),
    });
    expect(published.quote(run(1))).toEqual({ refused: { resolution: WAN_PRO_4K_REFUSAL } });
    expect(published.quote(run(9))).toEqual({ refused: { resolution: WAN_PRO_4K_REFUSAL } });
    // startImageGeneration refuses the same run in the same words, after it resolves the pictures and
    // before either path holds credits.
    const start = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/generation-services.ts'), 'utf8');
    expect(start).toContain("if (model === 'wan-2.7-image-pro' && resolution === '4K' && resolvedImageUrls.length > 0) {");
    expect(start).toContain(`throw new GenerationServiceError('${WAN_PRO_4K_REFUSAL}', 400);`);
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
});
