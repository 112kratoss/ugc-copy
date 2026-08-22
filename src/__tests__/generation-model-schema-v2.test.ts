import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  projectGenerationModelDescriptor,
  type GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import { buildGenerationModelCatalogEtag } from '@/lib/generation-model-catalog-route-adapter-service';

describe('generation model catalog schema v2', () => {
  it('publishes generic input modes, constraints, availability, and no provider-private data', () => {
    const catalog = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 2 });
    const seedance = catalog.models.find((model) => model.id === 'seedance-2');
    const wan = catalog.models.find((model) => model.id === 'wan-2.7');

    expect(catalog.schemaVersion).toBe(2);
    expect(seedance).toMatchObject({
      availability: { web: true, mobile: true },
      inputModes: expect.arrayContaining([
        expect.objectContaining({
          key: 'references',
          slots: expect.arrayContaining([
            expect.objectContaining({
              key: 'videoReferences',
              kind: 'video',
              role: 'reference',
              min: 0,
              max: 3,
              durationMetadata: 'required',
            }),
          ]),
        }),
      ]),
      inputConstraints: expect.arrayContaining([
        expect.objectContaining({
          type: 'combined-duration',
          slotKeys: ['videoReferences'],
          max: 15,
        }),
      ]),
    });
    expect(seedance?.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'referenceMode',
        type: 'choice',
        defaultValue: 'frames',
      }),
    ]));
    expect(wan?.inputModes?.find((mode) => mode.key === 'references')?.slots)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'startFrame', role: 'startFrame', max: 1 }),
      ]));
    expect(catalog.models.every((model) => (
      (model.inputModes?.length ?? 0) > 0
      && model.inputModes?.filter((mode) => mode.default).length === 1
    ))).toBe(true);
    expect(catalog.models.find((model) => model.id === 'imagen-4')?.inputModes)
      .toEqual([
        {
          key: 'prompt-only',
          label: 'Prompt only',
          default: true,
          slots: [],
        },
      ]);

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain('providerModelMap');
    expect(serialized).not.toContain('adapterConfig');
    expect(serialized).not.toContain('pricingConfig');
    expect(serialized).not.toContain('apiModelId');
  });

  it('keeps the v1 projection compatible and excludes v2-only models', () => {
    const v1 = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 });
    const seedance = v1.models.find((model) => model.id === 'seedance-2');
    const v2Only: GenerationModelDescriptor = {
      ...buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 2 }).models[0],
      id: 'catalog-only-v2',
      minClientSchemaVersion: 2,
    };

    expect(v1.schemaVersion).toBe(1);
    expect(seedance).not.toHaveProperty('availability');
    expect(seedance).not.toHaveProperty('inputModes');
    expect(seedance).not.toHaveProperty('inputConstraints');
    expect(seedance?.controls.some((control) => control.key === 'referenceMode')).toBe(false);
    expect(v1.models.some((model) => model.minClientSchemaVersion > 1)).toBe(false);
    expect(projectGenerationModelDescriptor(v2Only, 1)).not.toHaveProperty('inputModes');
  });

  it('uses projection-specific ETags even when release revisions are identical', () => {
    const mobileV1 = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 });
    const mobileV2 = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 2 });
    const mobileV3 = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 3 });
    const webV1 = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 });

    expect(mobileV1.revision).toBe(mobileV2.revision);
    expect(mobileV2.revision).toBe(mobileV3.revision);
    expect(mobileV1.revision).toBe(webV1.revision);
    expect(buildGenerationModelCatalogEtag(mobileV1, 'mobile'))
      .not.toBe(buildGenerationModelCatalogEtag(mobileV2, 'mobile'));
    expect(buildGenerationModelCatalogEtag(mobileV1, 'mobile'))
      .not.toBe(buildGenerationModelCatalogEtag(webV1, 'web'));
  });
});
