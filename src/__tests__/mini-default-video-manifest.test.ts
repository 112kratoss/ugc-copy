import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
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

import { descriptorBeforeKlingElementMinimum } from './fixtures/kling-element-min-duration-2026-10-30';
import { descriptorBeforeMiniDefault } from './fixtures/mini-default-video-2026-10-28';

/**
 * Release 2026-10-28-mini-default-video: Seedance 2 Mini becomes the default video model on
 * web and mobile, and its duration opens on 5 s instead of 10. A creator with no draft opens
 * on 480p for 5 s without sound, 19 credits, which a new account's 25 welcome credits cover;
 * Kling 3.0 at 5 s, the default until now, is 70. The owner chose it on 2026-10-28
 * (archive/creator-page-mockup-2026-10-28/README.md, decision 1). The catalog marks its
 * default `recommended`, so Kling 3.0 is re-emitted to drop the mark. Every entry must equal
 * the code build (the shadow verifier diffs projections), and each changes only what this
 * release names.
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
  publicDescriptor: Record<string, unknown> & { controls: Array<{ key: string; defaultValue: unknown }> };
}

interface Manifest {
  mode: string;
  release: { revision: string; basedOnRevision: string; schemaVersion: number };
  expectedModelIds: string[];
  addsModelIds?: string[];
  defaults: Record<'web' | 'mobile', Record<'image' | 'video' | 'motion', string>>;
  acceptanceQuotes?: Array<{ modelId: string; settings: Record<string, unknown>; expectedCredits: number }>;
  entries: ManifestEntry[];
}

function read(name: string): Manifest {
  return JSON.parse(fs.readFileSync(path.resolve(
    process.cwd(),
    `config/generation-model-catalog/releases/${name}`,
  ), 'utf8')) as Manifest;
}

const manifest = read('2026-10-28-mini-default-video.json');
const base = read('2026-10-20-kie-checkup.json');
// Production's entries until this release: the last releases that carried each model.
const previous = {
  'seedance-2-mini': base.entries.find((entry) => entry.modelId === 'seedance-2-mini')!,
  'kling-3.0-video': read('2026-09-04-reference-audit.json').entries.find((entry) => entry.modelId === 'kling-3.0-video')!,
};

const CHANGED = ['seedance-2-mini', 'kling-3.0-video'] as const;

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const operations = buildCodeGenerationModelOperations();

function entry(modelId: string): ManifestEntry {
  const found = manifest.entries.find((candidate) => candidate.modelId === modelId);
  if (!found) throw new Error(`no manifest entry for ${modelId}`);
  return found;
}

/** The settings a creator with no draft opens on: each control's default in the released descriptor. */
function openingSettings(modelId: string): Record<string, string | number | boolean> {
  return Object.fromEntries(entry(modelId).publicDescriptor.controls
    .map((control) => [control.key, control.defaultValue as string | number | boolean]));
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

const clip = (durationSeconds: number): CatalogRunInputFact => ({ slot: 'videoReferences', kind: 'video', durationSeconds });

describe('mini-default-video release', () => {
  it('chains onto the release production is running and changes the two models only', () => {
    expect(manifest.release.revision).toBe('mini-default-video-20261028');
    expect(manifest.release.basedOnRevision).toBe(base.release.revision);
    expect(manifest.release.schemaVersion).toBe(2);
    expect(manifest.mode).toBe('clone-active');
    expect(manifest.entries.map((candidate) => candidate.modelId)).toEqual([...CHANGED]);
    expect(manifest.addsModelIds).toBeUndefined();
    expect([...manifest.expectedModelIds].sort()).toEqual([...base.expectedModelIds, ...(base.addsModelIds ?? [])].sort());
  });

  it('makes Seedance 2 Mini the default video on both platforms and changes no other default', () => {
    for (const platform of ['web', 'mobile'] as const) {
      expect(manifest.defaults[platform]).toEqual({ ...base.defaults[platform], video: 'seedance-2-mini' });
    }
    expect(catalog.defaults.video).toBe('seedance-2-mini');
  });

  it.each(CHANGED)('%s is the code build', (modelId) => {
    const released = entry(modelId);
    const operation = operations.find((candidate) => candidate.modelId === modelId)!;
    const { schemaVersion, ...publicDescriptor } = released.publicDescriptor;
    expect(schemaVersion).toBe(2);
    expect(publicDescriptor).toEqual(descriptorBeforeKlingElementMinimum(catalog.models.find((model) => model.id === modelId)!));
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

  it('moves the recommended mark and Mini\'s duration default, and nothing else', () => {
    // The fixture the earlier release tests read today's build through, against production's entries.
    for (const modelId of CHANGED) {
      const released = entry(modelId);
      expect({
        ...released,
        publicDescriptor: descriptorBeforeMiniDefault(released.publicDescriptor as unknown as GenerationModelDescriptor),
      }).toEqual(previous[modelId]);
    }
    expect(entry('seedance-2-mini').publicDescriptor.recommended).toBe(true);
    expect(entry('kling-3.0-video').publicDescriptor.recommended).toBe(false);
  });

  it('opens Seedance 2 Mini on 480p for 5 s without sound, 19 credits', () => {
    expect(openingSettings('seedance-2-mini')).toEqual({
      aspectRatio: '16:9',
      resolution: '480p',
      duration: 5,
      sound: false,
      referenceMode: 'frames',
    });
    expect(quoteRun('seedance-2-mini', openingSettings('seedance-2-mini')).costCredits).toBe(19);
  });

  it('keeps Kie\'s list prices for Seedance 2 Mini and Kling 3.0', () => {
    // 3.8 a second at 480p and 8.2 at 720p without a clip, rounded up; 2.4 / 5 with one (input + output seconds).
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false }).costCredits).toBe(19);
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '480p', duration: 4, sound: false }).costCredits).toBe(16);
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '480p', duration: 10, sound: false }).costCredits).toBe(38);
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '480p', duration: 5, sound: true }).costCredits).toBe(19);
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '720p', duration: 10 }).costCredits).toBe(82);
    expect(quoteRun('seedance-2-mini', { aspectRatio: '16:9', resolution: '720p', duration: 5, referenceMode: 'elements' }, [clip(5)]).costCredits).toBe(50);
    expect(quoteRun('kling-3.0-video', openingSettings('kling-3.0-video')).costCredits).toBe(70);
    expect(manifest.acceptanceQuotes?.map((quote) => [quote.modelId, quote.settings, quote.expectedCredits])).toEqual([
      ['seedance-2-mini', { resolution: '480p', duration: 5, sound: false }, 19],
      ['seedance-2-mini', { resolution: '480p', duration: 4, sound: false }, 16],
      ['seedance-2-mini', { resolution: '720p', duration: 10 }, 82],
      ['seedance-2-mini', { resolution: '720p', duration: 5, referenceMode: 'elements' }, 50],
    ]);
  });
});
