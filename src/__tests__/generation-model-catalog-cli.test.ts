import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  quoteGenerationModel,
  type GenerationModelCatalog,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import type { GenerationModelOperationalConfig } from '@/lib/generation-model-runtime';
import {
  buildCatalogDiff,
  buildPublishPreview,
  buildStagePreview,
  calculateManifestAcceptanceQuote,
  loadActiveCatalog,
  materializeCatalogManifest,
  requireMutationApproval,
  runGenerationModelCatalogCli,
  validateCatalogManifest,
  type ActiveCatalogSnapshot,
} from '../../scripts/generation-model-catalog';

const manifestPath = path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json',
);
const seedMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260719035947_generation_model_catalog_control_plane.sql',
);

function loadManifestValue(): unknown {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function loadActiveSeed(): ActiveCatalogSnapshot {
  const migration = fs.readFileSync(seedMigrationPath, 'utf8');
  const encoded = migration.match(/decode\('([^']+)', 'base64'\)/)?.[1];
  if (!encoded) throw new Error('Catalog seed payload is missing.');
  const seed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    revision: string;
    defaults: ActiveCatalogSnapshot['defaults'];
    entries: Array<{
      model_id: string;
      kind: 'image' | 'video' | 'motion';
      public_descriptor: Record<string, unknown>;
      web_enabled: boolean;
      mobile_enabled: boolean;
      adapter_key: string;
      provider_model_map: Record<string, string>;
      pricing_strategy: string;
      pricing_config: Record<string, unknown>;
      validation_strategy: string;
      validation_config: Record<string, unknown>;
      verification_config: Record<string, unknown>;
    }>;
  };
  return {
    releaseId: '00000000-0000-4000-8000-000000000101',
    schemaVersion: 1,
    revision: seed.revision,
    defaults: seed.defaults,
    entries: seed.entries.map((entry) => ({
      modelId: entry.model_id,
      kind: entry.kind,
      publicDescriptor: entry.public_descriptor,
      webEnabled: entry.web_enabled,
      mobileEnabled: entry.mobile_enabled,
      adapterKey: entry.adapter_key,
      adapterConfig: {},
      providerModelMap: entry.provider_model_map,
      pricingStrategy: entry.pricing_strategy,
      pricingConfig: entry.pricing_config,
      validationStrategy: entry.validation_strategy,
      validationConfig: entry.validation_config,
      verificationConfig: entry.verification_config,
    })),
  };
}

function cloneManifestValue(): Record<string, unknown> {
  return structuredClone(loadManifestValue()) as Record<string, unknown>;
}

function changedSeedance(manifest: Record<string, unknown>) {
  return (manifest.entries as Array<Record<string, unknown>>)[0];
}

describe('generation-model catalog release CLI', () => {
  it('validates the versioned Seedance schema-v2 manifest', () => {
    const manifest = validateCatalogManifest(loadManifestValue());

    expect(manifest.release).toMatchObject({
      schemaVersion: 2,
      basedOnRevision: 'e271b74557d1e248',
    });
    expect(manifest.expectedModelIds).toHaveLength(29);
    expect(manifest.entries.map((entry) => entry.modelId)).toEqual(['seedance-2']);

    const descriptor = manifest.entries[0].publicDescriptor;
    const resolution = (descriptor.controls as Array<Record<string, unknown>>)
      .find((control) => control.key === 'resolution');
    expect((resolution?.options as Array<Record<string, unknown>>).map((option) => option.value))
      .toEqual(['480p', '720p', '1080p', '4k']);
    expect(descriptor.inputModes).toEqual(expect.any(Array));
    expect(descriptor.inputConstraints).toEqual(expect.any(Array));
  });

  it('allows one logical slot in different modes but rejects duplicates inside a mode', () => {
    const manifest = cloneManifestValue();
    const descriptor = changedSeedance(manifest).publicDescriptor as Record<string, unknown>;
    const modes = descriptor.inputModes as Array<Record<string, unknown>>;
    const frameSlot = structuredClone(
      (modes[0].slots as Array<Record<string, unknown>>)[0],
    );
    const referenceSlots = modes[1].slots as Array<Record<string, unknown>>;
    referenceSlots.push(frameSlot);

    expect(() => validateCatalogManifest(manifest)).not.toThrow();
    referenceSlots.push(structuredClone(frameSlot));
    expect(() => validateCatalogManifest(manifest)).toThrow(
      /has duplicate slot key startFrame/,
    );
  });

  it('materializes a complete release from the guarded active inventory', () => {
    const manifest = validateCatalogManifest(loadManifestValue());
    const active = loadActiveSeed();
    const release = materializeCatalogManifest(manifest, active);

    expect(release.entries).toHaveLength(29);
    expect(release.entries.every((entry) => entry.publicDescriptor.schemaVersion === 2))
      .toBe(true);
    expect(release.entries.every((entry) => Array.isArray(entry.publicDescriptor.inputModes)))
      .toBe(true);
    expect(release.defaults).toEqual(manifest.defaults);

    const diff = buildCatalogDiff(active, release);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.find((change) => change.modelId === 'seedance-2')).toMatchObject({
      publicDescriptor: true,
      adapter: true,
      pricing: true,
      validation: true,
    });
  });

  it('verifies the Seedance 1080p/4K acceptance quotes and reference billing', () => {
    const manifest = validateCatalogManifest(loadManifestValue());
    const seedance = manifest.entries[0];

    expect(manifest.acceptanceQuotes.map((quote) => (
      calculateManifestAcceptanceQuote(seedance, quote)
    ))).toEqual([714, 1456]);

    expect(calculateManifestAcceptanceQuote(seedance, {
      modelId: 'seedance-2',
      settings: { resolution: '1080p', duration: 7 },
      inputs: [{ slot: 'videoReferences', durationSeconds: 3 }],
      expectedCredits: 620,
    })).toBe(620);
  });

  it('uses the same key/options validation-rule contract as quote runtime', () => {
    const manifest = validateCatalogManifest(loadManifestValue());
    const seedance = manifest.entries[0];
    const catalog: GenerationModelCatalog = {
      schemaVersion: 2,
      revision: manifest.release.revision,
      defaults: {
        image: null,
        video: 'seedance-2',
        motion: null,
      },
      models: [
        seedance.publicDescriptor as unknown as GenerationModelDescriptor,
      ],
    };
    const operation = {
      modelId: seedance.modelId,
      kind: seedance.kind,
      adapterKey: seedance.adapterKey,
      adapterConfig: seedance.adapterConfig,
      providerModelMap: seedance.providerModelMap,
      pricingStrategy: seedance.pricingStrategy,
      pricingConfig: seedance.pricingConfig,
      validationStrategy: seedance.validationStrategy,
      validationConfig: seedance.validationConfig,
      verificationConfig: seedance.verificationConfig,
    } as GenerationModelOperationalConfig;

    expect(quoteGenerationModel({
      kind: 'video',
      modelId: 'seedance-2',
      settings: {
        aspectRatio: '16:9',
        resolution: '1080p',
        duration: 7,
        sound: false,
      },
      inputCounts: {
        images: 0,
        videos: 0,
        audios: 0,
      },
      catalogRevision: manifest.release.revision,
    }, {
      catalog,
      operations: new Map([['seedance-2', operation]]),
    }).costCredits).toBe(714);
  });

  it('keeps stage and publish previews free of private provider fields', () => {
    const manifest = validateCatalogManifest(loadManifestValue());
    const active = loadActiveSeed();
    const release = materializeCatalogManifest(manifest, active);
    const diff = buildCatalogDiff(active, release);
    const previews = JSON.stringify([
      buildStagePreview(manifest, active, diff),
      buildPublishPreview(manifest, active.revision, true),
    ]);

    expect(previews).not.toContain('bytedance/seedance-2');
    expect(previews).not.toContain('reference_video_urls');
    expect(previews).not.toContain('providerModelMap');
    expect(previews).not.toContain('adapterConfig');
    expect(previews).not.toContain('pricingConfig');
    expect(previews).not.toContain('"rates"');
  });

  it('loads a pre-migration active release when adapter_config is not present yet', async () => {
    const manifest = validateCatalogManifest(loadManifestValue());
    const seedance = manifest.entries[0];
    const entrySelects: string[] = [];
    const client = {
      from(table: string) {
        if (table === 'generation_model_catalog_releases') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'active-release',
                    schema_version: 1,
                    revision: manifest.release.basedOnRevision,
                    defaults: manifest.defaults,
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: (columns: string) => {
            entrySelects.push(columns);
            return {
              eq: () => ({
                order: async () => (
                  columns.includes('adapter_config')
                    ? {
                        data: null,
                        error: {
                          code: '42703',
                          message: 'column generation_model_catalog_entries.adapter_config does not exist',
                        },
                      }
                    : {
                        data: [{
                          model_id: seedance.modelId,
                          public_descriptor: seedance.publicDescriptor,
                          web_enabled: seedance.webEnabled,
                          mobile_enabled: seedance.mobileEnabled,
                          adapter_key: seedance.adapterKey,
                          provider_model_map: seedance.providerModelMap,
                          pricing_strategy: seedance.pricingStrategy,
                          pricing_config: seedance.pricingConfig,
                          validation_strategy: seedance.validationStrategy,
                          validation_config: seedance.validationConfig,
                          verification_config: seedance.verificationConfig,
                          generation_models: { kind: seedance.kind },
                        }],
                        error: null,
                      }
                ),
              }),
            };
          },
        };
      },
    };

    const active = await loadActiveCatalog(client as never);

    expect(entrySelects).toHaveLength(2);
    expect(entrySelects[0]).toContain('adapter_config');
    expect(entrySelects[1]).not.toContain('adapter_config');
    expect(active.entries[0].adapterConfig).toEqual({});
  });

  it.each([
    {
      name: 'implicit mode default',
      change: (manifest: Record<string, unknown>) => {
        const descriptor = changedSeedance(manifest).publicDescriptor as Record<string, unknown>;
        const modes = descriptor.inputModes as Array<Record<string, unknown>>;
        delete modes[1].default;
      },
      message: /default must be a boolean/,
    },
    {
      name: 'unpriced reference duration metadata',
      change: (manifest: Record<string, unknown>) => {
        const descriptor = changedSeedance(manifest).publicDescriptor as Record<string, unknown>;
        const modes = descriptor.inputModes as Array<Record<string, unknown>>;
        const referenceSlots = modes[1].slots as Array<Record<string, unknown>>;
        delete referenceSlots.find((slot) => slot.key === 'videoReferences')?.durationMetadata;
      },
      message: /videoReferences\.durationMetadata to be required/,
    },
    {
      name: 'unknown adapter',
      change: (manifest: Record<string, unknown>) => {
        changedSeedance(manifest).adapterKey = 'arbitrary-http';
      },
      message: /unsupported adapter/,
    },
    {
      name: 'unknown validation rule',
      change: (manifest: Record<string, unknown>) => {
        const entry = changedSeedance(manifest);
        const validation = entry.validationConfig as Record<string, unknown>;
        validation.rules = [{ type: 'execute-javascript' }];
      },
      message: /unsupported validation rule/,
    },
    {
      name: 'malformed validation rule',
      change: (manifest: Record<string, unknown>) => {
        const entry = changedSeedance(manifest);
        const validation = entry.validationConfig as Record<string, unknown>;
        validation.rules = [{ type: 'max-slot-count', max: 3 }];
      },
      message: /slotKey must be a non-empty string/,
    },
    {
      name: 'negative pricing',
      change: (manifest: Record<string, unknown>) => {
        const entry = changedSeedance(manifest);
        const pricing = entry.pricingConfig as Record<string, unknown>;
        const rates = pricing.rates as Record<string, Record<string, number>>;
        rates.noReference['1080p'] = -1;
      },
      message: /cannot be negative/,
    },
    {
      name: 'invalid control default',
      change: (manifest: Record<string, unknown>) => {
        const descriptor = changedSeedance(manifest).publicDescriptor as Record<string, unknown>;
        const resolution = (descriptor.controls as Array<Record<string, unknown>>)
          .find((control) => control.key === 'resolution');
        if (resolution) resolution.defaultValue = '8k';
      },
      message: /default 8k is not an option/,
    },
    {
      name: 'incompatible minimum schema',
      change: (manifest: Record<string, unknown>) => {
        const descriptor = changedSeedance(manifest).publicDescriptor as Record<string, unknown>;
        descriptor.minClientSchemaVersion = 3;
      },
      message: /incompatible minimum client schema/,
    },
    {
      name: 'provider endpoint injection',
      change: (manifest: Record<string, unknown>) => {
        const entry = changedSeedance(manifest);
        const adapterConfig = entry.adapterConfig as Record<string, unknown>;
        adapterConfig.endpoint = 'https://attacker.example';
      },
      message: /cannot select an endpoint/,
    },
    {
      name: 'embedded credential',
      change: (manifest: Record<string, unknown>) => {
        const entry = changedSeedance(manifest);
        const adapterConfig = entry.adapterConfig as Record<string, unknown>;
        adapterConfig.apiKey = 'must-not-be-stored';
      },
      message: /forbidden credential field apiKey/,
    },
  ])('rejects $name', ({ change, message }) => {
    const manifest = cloneManifestValue();
    change(manifest);
    expect(() => validateCatalogManifest(manifest)).toThrow(message);
  });

  it('refuses to materialize a stale revision or changed model inventory', () => {
    const manifest = validateCatalogManifest(loadManifestValue());
    const stale = loadActiveSeed();
    stale.revision = 'different-active-revision';
    expect(() => materializeCatalogManifest(manifest, stale)).toThrow(
      /does not match manifest base/,
    );

    const changedInventory = loadActiveSeed();
    changedInventory.entries.pop();
    expect(() => materializeCatalogManifest(manifest, changedInventory)).toThrow(
      /inventory does not match/,
    );
  });

  it('requires explicit, exact revision confirmation for every mutation', () => {
    expect(() => requireMutationApproval(
      new Map(),
      'seedance2-hd-v2-20260724',
    )).toThrow(/without --apply/);
    expect(() => requireMutationApproval(
      new Map<string, string | true>([
        ['--apply', true],
        ['--confirm-revision', 'wrong-revision'],
      ]),
      'seedance2-hd-v2-20260724',
    )).toThrow(/exactly match/);
    expect(() => requireMutationApproval(
      new Map<string, string | true>([
        ['--apply', true],
        ['--confirm-revision', 'seedance2-hd-v2-20260724'],
      ]),
      'seedance2-hd-v2-20260724',
    )).not.toThrow();
  });

  it('validates locally and emits only a sanitized release summary', async () => {
    const messages: string[] = [];
    await runGenerationModelCatalogCli(
      ['validate', '--manifest', manifestPath, '--json'],
      {},
      { log: (message) => messages.push(message) },
    );

    const output = messages.join('\n');
    expect(output).toContain('"status": "valid"');
    expect(output).toContain('"acceptanceQuoteCount": 2');
    expect(output).not.toContain('bytedance/seedance-2');
    expect(output).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(output).not.toContain('"rates"');
  });
});
