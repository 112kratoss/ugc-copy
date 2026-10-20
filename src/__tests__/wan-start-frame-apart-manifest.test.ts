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

import { descriptorBeforeKieCheckup, operationBeforeKieCheckup } from './fixtures/kie-checkup-2026-10-20';

/**
 * Release 2026-10-19-wan-start-frame-apart: wan/2-7-r2v takes `reference_image` and
 * `reference_video`, five in total, and a `first_frame` of its own beside them
 * (docs/model-api-references/reference-audit-2026-09-04.md). The published descriptor
 * already counted only the reference slots, but Wan 2.7's two quote rules counted every
 * picture the run sends, so five references and a start frame were refused. This release
 * keys both rules on the reference slots and changes nothing else about the model. Its
 * entry must equal the code build (the shadow verifier diffs projections), read as it stood
 * before the 2026-10-20 check-up capped the reference voice at 10 s and refused it alone.
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
  verificationConfig: Record<string, unknown>;
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

const manifest = read('2026-10-19-wan-start-frame-apart.json');
const base = read('2026-10-08-pixverse-mobile.json');
// Production's Wan 2.7 entry until this release: the last release that carried it.
const previous = read('2026-09-04-reference-audit.json').entries.find((entry) => entry.modelId === 'wan-2.7')!;

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operation = operationBeforeKieCheckup(
  buildCodeGenerationModelOperations().find((candidate) => candidate.modelId === 'wan-2.7')!,
);

function entry(): ManifestEntry {
  const found = manifest.entries.find((candidate) => candidate.modelId === 'wan-2.7');
  if (!found) throw new Error('no manifest entry for wan-2.7');
  return found;
}

type Rule = Record<string, unknown>;

function rules(config: Record<string, unknown>): Rule[] {
  return config.rules as Rule[];
}

/** Quotes a run against the release's own entry, as production will once it is published. */
function quoteRun(inputs: CatalogRunInputFact[]) {
  const released = entry();
  const config: GenerationModelOperationalConfig = {
    modelId: released.modelId,
    kind: 'video',
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
    kind: 'video',
    modelId: 'wan-2.7',
    catalogRevision: catalog.revision,
    settings: { aspectRatio: '16:9', duration: 5, resolution: '720p', referenceMode: 'elements' },
    inputs,
  }), { catalog, operations: new Map([['wan-2.7', config]]) });
}

function fieldErrorsFor(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.fieldErrors;
    throw error;
  }
  throw new Error('expected the quote to be refused');
}

const picture: CatalogRunInputFact = { slot: 'imageReferences', kind: 'image' };
const clip: CatalogRunInputFact = { slot: 'videoReferences', kind: 'video', durationSeconds: 3 };
const voice: CatalogRunInputFact = { slot: 'audioReferences', kind: 'audio', durationSeconds: 3 };
const startFrame: CatalogRunInputFact = { slot: 'startFrame', kind: 'image' };
const times = (count: number, input: CatalogRunInputFact) => Array.from({ length: count }, () => input);

describe('wan-start-frame-apart release', () => {
  it('chains onto the release production is running and changes Wan 2.7 only', () => {
    expect(manifest.release.revision).toBe('wan-start-frame-apart-20261019');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((candidate) => candidate.modelId)).toEqual(['wan-2.7']);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
  });

  it('is the code build', () => {
    const { schemaVersion, ...publicDescriptor } = entry().publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(descriptorBeforeKieCheckup(catalog.models.find((model) => model.id === 'wan-2.7')!));
    expect(entry().adapterKey).toBe(operation.adapterKey);
    expect(entry().adapterConfig).toEqual(operation.adapterConfig);
    expect(entry().providerModelMap).toEqual(operation.providerModelMap);
    expect(entry().pricingStrategy).toBe(operation.pricingStrategy);
    expect(entry().pricingConfig).toEqual(operation.pricingConfig);
    expect(entry().validationStrategy).toBe(operation.validationStrategy);
    // The emitter drops an empty passthroughSettingKeys, which the runtime reads as absent.
    const { passthroughSettingKeys, ...validationConfig } = operation.validationConfig as Record<string, unknown>;
    expect(entry().validationConfig).toEqual(
      Array.isArray(passthroughSettingKeys) && passthroughSettingKeys.length > 0
        ? { ...validationConfig, passthroughSettingKeys }
        : validationConfig,
    );
  });

  it('changes the two reference-count rules and nothing else about the model', () => {
    const after = entry();
    expect(after.publicDescriptor).toEqual(previous.publicDescriptor);
    expect(after.providerModelMap).toEqual(previous.providerModelMap);
    expect(after.adapterConfig).toEqual(previous.adapterConfig);
    expect(after.pricingStrategy).toBe(previous.pricingStrategy);
    expect(after.pricingConfig).toEqual(previous.pricingConfig);
    expect({ ...after.validationConfig, rules: undefined }).toEqual({ ...previous.validationConfig, rules: undefined });

    const changed = rules(after.validationConfig)
      .map((rule, index) => [index, rule, rules(previous.validationConfig)[index]] as const)
      .filter(([, rule, before]) => JSON.stringify(rule) !== JSON.stringify(before));
    expect(rules(after.validationConfig)).toHaveLength(rules(previous.validationConfig).length);
    expect(changed.map(([, rule]) => rule)).toEqual([
      {
        type: 'max-slot-count',
        slotKey: 'imageReferences',
        max: 5,
        conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' }],
        field: 'images',
        message: 'Wan 2.7 supports up to 5 reference images.',
      },
      expect.objectContaining({
        type: 'weighted-slot-count',
        weights: { imageReferences: 1, videoReferences: 1, audioReferences: 1 },
        max: 5,
      }),
    ]);
    expect(changed.map(([, , before]) => before)).toEqual([
      expect.objectContaining({ type: 'max-slot-count', slotKey: 'images', max: 5 }),
      expect.objectContaining({ type: 'weighted-slot-count', weights: { images: 1, videos: 1, audios: 1 } }),
    ]);
  });

  it('quotes five references beside a start frame at the per-second price', () => {
    // 720p is 16 credits a second (models.ts), so a five-second run is 80.
    expect(quoteRun([...times(5, picture), startFrame]).costCredits).toBe(80);
    expect(quoteRun([...times(5, clip), startFrame]).costCredits).toBe(80);
    expect(quoteRun([...times(3, picture), clip, voice, startFrame]).costCredits).toBe(80);
  });

  it('still refuses a sixth reference, with the message the creators show today', () => {
    const errors = fieldErrorsFor(() => quoteRun([...times(6, picture), startFrame]));
    // Both creators show the first field error.
    expect(Object.values(errors)[0]).toBe('Wan 2.7 supports up to 5 reusable references in total.');
    expect(errors.references).toBe('Wan 2.7 supports up to 5 reusable references in total.');
    expect(fieldErrorsFor(() => quoteRun([...times(5, clip), voice])).references)
      .toBe('Wan 2.7 supports up to 5 reusable references in total.');
  });
});
