import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  CatalogError,
  quoteGenerationModel,
  type CatalogInputMode,
  type GenerationModelDescriptor,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import {
  CLIENT_RENDERED_CONTROL_TYPES,
  CLIENT_RENDERED_INPUT_CONSTRAINT_TYPES,
  CLIENT_RENDERED_INPUT_MODE_KEYS,
  CLIENT_RENDERED_INPUT_SLOT_KINDS,
  CLIENT_RENDERED_INPUT_SLOT_ROLES,
  SUBJECT_IMAGES_PER_NAME,
  SUBJECT_IMAGES_SLOT_KEY,
  catalogConditionsMatch,
  catalogRunQuoteInput,
  modeGatedSettingValues,
} from '../../ugc-mobile/lib/model-catalog/protocol';

/**
 * Every capability the catalog publishes must be one both creators draw. The lists
 * live in the shared protocol module; the native parser is held to the same lists by
 * ugc-mobile/__tests__/model-catalog-client-parity.test.ts, and the web creator's
 * affordances by generation-model-affordances.test.ts. Named subjects were the gap
 * this closes: the server built a `subjects` mode that only the web page knew how to
 * group, so Kling O3 named subjects reached one client and not the other.
 */

type Offence = { model: string; what: string };

function descriptors(): GenerationModelDescriptor[] {
  const seen = new Map<string, GenerationModelDescriptor>();
  for (const platform of ['web', 'mobile'] as const) {
    for (const schemaVersion of [2, 3] as const) {
      for (const model of buildGenerationModelCatalog({ platform, schemaVersion }).models) {
        seen.set(`${platform}:${schemaVersion}:${model.id}`, model);
      }
    }
  }
  return [...seen.values()];
}

const includes = (list: readonly string[], value: string) => list.includes(value);

describe('the catalog publishes only what both creators render', () => {
  const models = descriptors();

  it('builds a catalog for both platforms', () => {
    expect(models.length).toBeGreaterThan(30);
  });

  it('uses only the shared control types', () => {
    const offences: Offence[] = [];
    for (const model of models) {
      for (const control of model.controls) {
        if (!includes(CLIENT_RENDERED_CONTROL_TYPES, control.type)) {
          offences.push({ model: model.id, what: `control ${control.key} of type ${control.type}` });
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('uses only the shared input mode keys, slot kinds and slot roles', () => {
    const offences: Offence[] = [];
    for (const model of models) {
      for (const mode of model.inputModes ?? []) {
        if (!includes(CLIENT_RENDERED_INPUT_MODE_KEYS, mode.key)) {
          offences.push({ model: model.id, what: `input mode ${mode.key}` });
        }
        for (const slot of mode.slots) {
          if (!includes(CLIENT_RENDERED_INPUT_SLOT_KINDS, slot.kind)) {
            offences.push({ model: model.id, what: `slot ${slot.key} of kind ${slot.kind}` });
          }
          if (!includes(CLIENT_RENDERED_INPUT_SLOT_ROLES, slot.role)) {
            offences.push({ model: model.id, what: `slot ${slot.key} with role ${slot.role}` });
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('quotes every reference mode a model\'s input modes are gated on, whatever its Input mode control lists', () => {
    // The modes are the contract; a control is a picker's summary of them and can fall
    // behind, as Kling O3's did when its subjects mode was published beside a control
    // naming frames and references only. Every quote for a subjects run was refused.
    const refusals: Offence[] = [];
    for (const model of models) {
      if (model.kind !== 'video') continue;
      const gated = new Set((model.inputModes ?? []).flatMap((mode) => (mode.conditions ?? [])
        .filter((condition) => condition.source === 'setting' && condition.key === 'referenceMode' && condition.operator === 'equals')
        .map((condition) => String(condition.value))));
      const defaults = Object.fromEntries(model.controls.map((control) => [control.key, control.defaultValue]));
      for (const referenceMode of gated) {
        try {
          quoteGenerationModel({
            schemaVersion: 2,
            kind: 'video',
            modelId: model.id,
            settings: { ...defaults, referenceMode },
            inputCounts: { images: 0, videos: 0, audios: 0 },
          } as GenerationModelQuoteInput);
        } catch (error) {
          const refusal = error instanceof CatalogError ? error.fieldErrors.referenceMode : String(error);
          if (refusal) refusals.push({ model: model.id, what: `${referenceMode}: ${refusal}` });
        }
      }
    }
    expect(refusals).toEqual([]);
  });

  it('opens no input shape whose run its quote refuses, on any option of the tier control', () => {
    // Both creators draw the slots a descriptor opens, so a slot its own quote refuses is a run
    // that cannot start: Veo 3.1 opened its reference pictures on every variant while the quote
    // took them on Lite and Fast only ("Reusable references require Veo Lite or Fast."). Each
    // shape is quoted on each option of the model's `mode` control, the one setting besides the
    // shape that the web creator reads a descriptor's input modes with, the others at their
    // defaults, with an input in every slot it opens. They go together, as an end frame needs a
    // start frame and Wan 2.7's and MiniMax H3's audio a picture or a clip beside it. Rules on
    // other settings (Veo's 16:9 or 9:16 for a run with pictures) refuse at the quote instead.
    const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3, includeUnavailable: true });
    const operations = new Map(buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry]));
    const offered = catalog.models.filter((model) => model.kind === 'video' && (model.availability?.web || model.availability?.mobile));
    const refusals: Offence[] = [];
    const quoted: string[] = [];
    const quotedModels = new Set<string>();
    for (const model of offered) {
      const defaults = Object.fromEntries(model.controls.map((control) => [control.key, control.defaultValue]));
      const tierControl = model.controls.find((control) => control.key === 'mode');
      const tiers = tierControl?.type === 'choice' ? tierControl.options.map((option) => option.value) : [undefined];
      const shapes = [...modeGatedSettingValues(model.inputModes).get('referenceMode') ?? [undefined]];
      for (const tier of tiers) {
        for (const referenceMode of shapes) {
          const settings = {
            ...defaults,
            ...(tier === undefined ? {} : { mode: tier }),
            ...(referenceMode === undefined ? {} : { referenceMode }),
          };
          const open = (model.inputModes ?? [])
            .filter((mode) => catalogConditionsMatch(mode.conditions, settings))
            .flatMap((mode) => mode.slots)
            .filter((slot) => slot.max > 0 && catalogConditionsMatch(slot.conditions, settings));
          if (open.length === 0) continue;
          const inputs = open.flatMap((slot) => Array.from({ length: Math.max(1, slot.min) }, () => ({
            slot: slot.key,
            kind: slot.kind,
            ...(slot.kind === 'video' || slot.kind === 'audio' ? { durationSeconds: 4 } : {}),
          })));
          const run = `${model.id}, ${tier ?? 'one tier'}, ${referenceMode ?? 'one shape'}, ${open.map((slot) => slot.key).join(' + ')}`;
          try {
            quoteGenerationModel(catalogRunQuoteInput({
              kind: 'video',
              modelId: model.id,
              catalogRevision: catalog.revision,
              settings,
              inputs,
            }) as GenerationModelQuoteInput, { catalog, operations });
            quoted.push(run);
            quotedModels.add(model.id);
          } catch (error) {
            const refusal = error instanceof CatalogError ? Object.values(error.fieldErrors).join(' ') : String(error);
            refusals.push({ model: model.id, what: `${run}: ${refusal}` });
          }
        }
      }
    }
    expect(refusals).toEqual([]);
    // A sweep that opened nothing would pass: it quoted a run on every offered video model, and
    // Veo's pictures on the two variants that take them.
    expect([...quotedModels].sort()).toEqual(offered.map((model) => model.id).sort());
    expect(quoted).toEqual(expect.arrayContaining([
      'veo-3.1, veo3_lite, elements, imageReferences',
      'veo-3.1, veo3_fast, elements, imageReferences',
    ]));
  });

  it('uses only the shared constraint types', () => {
    const offences: Offence[] = [];
    for (const model of models) {
      for (const constraint of model.inputConstraints ?? []) {
        if (!includes(CLIENT_RENDERED_INPUT_CONSTRAINT_TYPES, constraint.type)) {
          offences.push({ model: model.id, what: `constraint of type ${constraint.type}` });
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe('named subjects', () => {
  const contract = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), 'contracts/model-catalog-subjects-mode-v1.json'),
    'utf8',
  )) as { modelId: string; inputMode: CatalogInputMode; imagesPerSubject: { min: number; max: number } };

  it('are published as the mode the contract fixture records', () => {
    const model = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 3 }).models
      .find((candidate) => candidate.id === contract.modelId);
    expect(model).toBeDefined();
    const mode = model!.inputModes?.find((candidate) => candidate.key === 'subjects');
    expect(mode).toEqual(contract.inputMode);
  });

  it('travel in the slot both creators group on, and in the range the server enforces', () => {
    expect(contract.inputMode.slots.map((slot) => slot.key)).toEqual([SUBJECT_IMAGES_SLOT_KEY]);
    expect(contract.imagesPerSubject).toEqual(SUBJECT_IMAGES_PER_NAME);
    const slot = contract.inputMode.slots[0];
    // Up to maxNamed subjects of up to `max` pictures each fit the slot exactly.
    expect(slot.max).toBe(slot.maxNamed! * SUBJECT_IMAGES_PER_NAME.max);
  });

  it('quote on Kling O3 as the native creator sends them, and refuse a run of too many pictures', () => {
    const quote = (count: number) => quoteGenerationModel({
      schemaVersion: 2,
      kind: 'video',
      modelId: 'kling-o3',
      settings: { aspectRatio: '16:9', resolution: '720p', duration: 5, sound: false, isMultiShot: false, referenceMode: 'subjects' },
      inputCounts: { images: count, videos: 0, audios: 0 },
      inputMetadata: { slots: { [SUBJECT_IMAGES_SLOT_KEY]: { count } } },
    } as GenerationModelQuoteInput);
    expect(quote(2).costCredits).toBeGreaterThan(0);
    expect(quote(12).costCredits).toBe(quote(2).costCredits);
    expect(() => quote(13)).toThrow(CatalogError);
  });

  it('is the only subjects mode, and every one is gated on its own reference mode', () => {
    const models = descriptors();
    for (const model of models) {
      for (const mode of model.inputModes ?? []) {
        if (mode.key !== 'subjects') continue;
        expect(mode.conditions, model.id).toEqual([
          { source: 'setting', key: 'referenceMode', operator: 'equals', value: 'subjects' },
        ]);
        expect(mode.slots.map((slot) => slot.key), model.id).toEqual([SUBJECT_IMAGES_SLOT_KEY]);
      }
    }
  });
});
