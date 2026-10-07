import { describe, expect, it } from 'vitest';

import subjectsContract from '../../contracts/model-catalog-subjects-mode-v1.json';
import {
  getActiveCatalogInputSlots,
  parseGenerationModelCatalog,
  type CatalogInputMode,
  type GenerationModelDescriptor,
} from '../lib/generation-model-catalog';
import {
  applyCatalogModelDefaults,
  buildCatalogQuoteRequest,
  buildUnifiedCatalogGenerationRequest,
  catalogSubjectSlot,
  hydrateCatalogCreationDraftFromRemixSource,
  reconcileCreationDraftWithCatalog,
  validateCatalogCreationDraft,
} from '../lib/generation-model-draft';
import {
  createDefaultCreationDraft,
  createSubjectDraft,
  renameSubjectDraft,
  subjectAsReference,
  type MediaDraft,
  type VideoCreationDraft,
} from '../lib/media-creation-view-model';
import {
  CLIENT_RENDERED_CONTROL_TYPES,
  CLIENT_RENDERED_INPUT_CONSTRAINT_TYPES,
  CLIENT_RENDERED_INPUT_MODE_KEYS,
  CLIENT_RENDERED_INPUT_SLOT_KINDS,
  CLIENT_RENDERED_INPUT_SLOT_ROLES,
  SUBJECT_IMAGES_PER_NAME,
  SUBJECT_IMAGES_SLOT_KEY,
  subjectsPerRun,
} from '../lib/model-catalog/protocol';
import type { RemixSourceBundle } from '../lib/types';
import { catalogV2, remoteVideoModel } from './generation-model-catalog-v2-fixtures';

/**
 * The server's catalog build is held to the shared lists in the protocol module
 * (src/__tests__/model-catalog-client-parity.test.ts). This side proves the native
 * parser keeps everything on those lists and drops anything off them, and that the
 * draft can enter the one mode that used to reach the web creator alone: named
 * subjects, whose shape is pinned in contracts/model-catalog-subjects-mode-v1.json.
 */

const subjectsMode = subjectsContract.inputMode as CatalogInputMode;

function rawVideoModel(overrides: Record<string, unknown> = {}) {
  return {
    ...remoteVideoModel(),
    ...overrides,
  };
}

function parseOne(model: Record<string, unknown>): GenerationModelDescriptor {
  const catalog = parseGenerationModelCatalog({
    schemaVersion: 2,
    revision: 'parity-rev',
    defaults: { image: null, video: model.id, motion: null },
    models: [model],
  }, 2);
  return catalog.models[0];
}

function rejects(model: Record<string, unknown>) {
  expect(() => parseOne(model)).toThrow('Invalid model catalog.');
}

function picture(index: number, handle?: string): MediaDraft {
  return {
    id: `picture-${index}`,
    kind: 'image',
    url: `https://cdn.example.com/picture-${index}.jpg`,
    storagePath: `generation_inputs/owner/picture-${index}.jpg`,
    fileName: `picture-${index}.jpg`,
    displayName: `Picture ${index}`,
    ...(handle ? { handle } : {}),
  };
}

/**
 * A video model that takes named subjects, as the contract fixture publishes them. The
 * shared fixture publishes `referenceMode` as a control of two options, which the
 * server's descriptors never do (it is a passthrough setting read off the run's
 * attachments), and a control that names no `subjects` option would turn the mode
 * back into `elements`; the server would refuse such a value too.
 */
function subjectVideoModel(): GenerationModelDescriptor {
  const base = remoteVideoModel('subject-video');
  return {
    ...base,
    controls: base.controls.filter((control) => control.key !== 'referenceMode'),
    inputModes: [...(base.inputModes ?? []), subjectsMode],
  };
}

function subjectDraft(model: GenerationModelDescriptor, subjects: VideoCreationDraft['subjects'], extra: Partial<VideoCreationDraft> = {}): VideoCreationDraft {
  return applyCatalogModelDefaults({
    ...createDefaultCreationDraft('video'),
    model: model.id as VideoCreationDraft['model'],
    prompt: 'A hero walks in',
    subjects,
    ...extra,
  }, model) as VideoCreationDraft;
}

describe('the native parser renders exactly what the shared lists name', () => {
  it('keeps a descriptor that uses every control type, mode key, slot kind, slot role and constraint type', () => {
    const slotKinds = [...CLIENT_RENDERED_INPUT_SLOT_KINDS];
    const slotRoles = [...CLIENT_RENDERED_INPUT_SLOT_ROLES];
    const descriptor = parseOne(rawVideoModel({
      controls: [
        { key: 'resolution', label: 'Resolution', type: 'choice', presentation: 'chips', defaultValue: '720p', options: [{ value: '720p', label: '720p' }] },
        { key: 'sound', label: 'Sound', type: 'boolean', presentation: 'toggle', defaultValue: false },
        { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 5, min: 1, max: 10, step: 1 },
      ],
      inputModes: CLIENT_RENDERED_INPUT_MODE_KEYS.map((key, modeIndex) => ({
        key,
        label: key,
        default: modeIndex === 0,
        slots: slotKinds.map((kind, slotIndex) => ({
          key: `${key}-${kind}`,
          kind,
          role: slotRoles[slotIndex % slotRoles.length],
          label: `${key} ${kind}`,
          min: 0,
          max: 2,
        })),
      })),
      inputConstraints: CLIENT_RENDERED_INPUT_CONSTRAINT_TYPES.map((type) => ({
        type,
        slotKeys: ['prompt-only-image'],
        max: 2,
        message: `${type} message`,
        ...(type === 'weighted-count' ? { weights: { 'prompt-only-image': 1 } } : {}),
      })),
    }));
    expect(descriptor.controls.map((control) => control.type)).toEqual([...CLIENT_RENDERED_CONTROL_TYPES]);
    expect(descriptor.inputModes?.map((mode) => mode.key)).toEqual([...CLIENT_RENDERED_INPUT_MODE_KEYS]);
    expect(descriptor.inputConstraints?.map((constraint) => constraint.type)).toEqual([...CLIENT_RENDERED_INPUT_CONSTRAINT_TYPES]);
  });

  it('drops a descriptor whose control, slot kind, slot role or constraint is not on the lists', () => {
    const base = remoteVideoModel();
    rejects(rawVideoModel({
      controls: [{ key: 'seed', label: 'Seed', type: 'number', presentation: 'field', defaultValue: 1 }],
    }));
    rejects(rawVideoModel({
      inputModes: [{ ...base.inputModes![0], slots: [{ ...base.inputModes![0].slots[0], kind: 'subject' }] }],
    }));
    rejects(rawVideoModel({
      inputModes: [{ ...base.inputModes![0], slots: [{ ...base.inputModes![0].slots[0], role: 'mask' }] }],
    }));
    rejects(rawVideoModel({
      inputConstraints: [{ type: 'file-size', slotKeys: ['imageReferences'], max: 1, message: 'too big' }],
    }));
  });

  it('keeps the subjects mode as the contract fixture publishes it', () => {
    const descriptor = parseOne(rawVideoModel({ inputModes: [...remoteVideoModel().inputModes!, subjectsMode] }));
    expect(descriptor.inputModes?.find((mode) => mode.key === 'subjects')).toEqual(subjectsMode);
    expect(catalogSubjectSlot(descriptor)).toEqual(subjectsMode.slots[0]);
    expect(subjectsContract.imagesPerSubject).toEqual(SUBJECT_IMAGES_PER_NAME);
  });

  it('counts the subjects a run takes from the slot, with or without maxNamed', () => {
    // The release production ran on 2026-10-07 published the slot before maxNamed
    // existed, and the Pixel 9a emulator offered "Subject 0/12" until this rule.
    expect(subjectsPerRun(subjectsMode.slots[0])).toBe(3);
    expect(subjectsPerRun({ max: 12 })).toBe(3);
    expect(subjectsPerRun({ max: 12, maxNamed: 2 })).toBe(2);
    expect(subjectsPerRun({ max: 0 })).toBe(0);
  });
});

describe('named subjects on the native creator', () => {
  const model = subjectVideoModel();

  it('activates the subjects slot alone once a subject is attached, and the references slot without one', () => {
    const hero = createSubjectDraft([picture(1), picture(2)], 'Hero', []);
    const withSubject = subjectDraft(model, [hero]);
    expect(withSubject.referenceMode).toBe('subjects');
    expect(getActiveCatalogInputSlots(model, { referenceMode: 'subjects' }).map((slot) => slot.key)).toEqual([SUBJECT_IMAGES_SLOT_KEY]);

    const withoutSubject = subjectDraft(model, []);
    expect(withoutSubject.referenceMode).not.toBe('subjects');
  });

  it('sends one input per picture in the subjects slot, each under the subject\'s handle and name', () => {
    const hero = createSubjectDraft([picture(1), picture(2), picture(3)], 'Hero', []);
    const draft = subjectDraft(model, [hero], { prompt: '@hero lifts the serum' });
    const request = buildUnifiedCatalogGenerationRequest(draft, model, 'catalog-v2-revision');

    expect(request.settings.referenceMode).toBe('subjects');
    expect(request.inputs).toHaveLength(3);
    for (const input of request.inputs) {
      expect(input).toMatchObject({ slot: SUBJECT_IMAGES_SLOT_KEY, kind: 'image', handle: '@hero', label: 'Hero' });
    }
    expect(request.inputs.map((input) => input.storagePath)).toEqual(hero.images.map((image) => image.storagePath));
  });

  it('quotes the subject pictures as the run\'s images', () => {
    const hero = createSubjectDraft([picture(1), picture(2)], 'Hero', []);
    const quote = buildCatalogQuoteRequest(subjectDraft(model, [hero]), model, 'catalog-v2-revision');
    expect(quote.kind).toBe('video');
    expect(quote.inputCounts.images).toBe(2);
    expect(quote.inputMetadata?.slots?.[SUBJECT_IMAGES_SLOT_KEY]).toMatchObject({ count: 2 });
  });

  it('leaves saved references out of a subjects run', () => {
    const hero = createSubjectDraft([picture(1), picture(2)], 'Hero', []);
    const draft = subjectDraft(model, [hero], { references: [picture(9, '@prop')] });
    const request = buildUnifiedCatalogGenerationRequest(draft, model, 'catalog-v2-revision');
    expect(request.inputs.every((input) => input.slot === SUBJECT_IMAGES_SLOT_KEY)).toBe(true);
  });

  it('accepts a prompt that mentions a subject, and refuses one that mentions nothing attached', () => {
    const hero = createSubjectDraft([picture(1), picture(2)], 'Hero', []);
    const known = validateCatalogCreationDraft(subjectDraft(model, [hero], { prompt: '@hero waves' }), model, { credits: 999 });
    expect(known.errors).toEqual([]);
    const unknown = validateCatalogCreationDraft(subjectDraft(model, [hero], { prompt: '@villain waves' }), model, { credits: 999 });
    expect(unknown.errors.join(' ')).toMatch(/@villain/);
  });

  it('holds a subject to the pictures the server fuses, and a run to the subjects the model names', () => {
    const lone = createSubjectDraft([picture(1)], 'Lone', []);
    const tooFew = validateCatalogCreationDraft(subjectDraft(model, [lone]), model, { credits: 999 });
    expect(tooFew.errors).toContain(`Lone needs ${SUBJECT_IMAGES_PER_NAME.min} to ${SUBJECT_IMAGES_PER_NAME.max} pictures of the same person or thing.`);

    const four = ['A', 'B', 'C', 'D'].map((name, index) => createSubjectDraft([picture(index * 2), picture(index * 2 + 1)], name, []));
    // applyCatalogModelDefaults keeps as many subjects as the slot names; the check below reads the raw draft.
    const raw: VideoCreationDraft = { ...subjectDraft(model, four.slice(0, 3)), subjects: four, referenceMode: 'subjects' };
    const tooMany = validateCatalogCreationDraft(raw, model, { credits: 999 });
    expect(tooMany.errors).toContain(`${model.displayName} takes up to 3 named subjects per run.`);
  });

  it('keeps a subjects draft through reconciliation with the control production publishes', () => {
    // The release production runs publishes Kling O3's Input mode control with frames and
    // references only, beside its subjects mode. Read against the control alone, a saved
    // subjects draft came back as "settings … reset: referenceMode" on the Pixel 9a
    // emulator; the modes say the shape is supported.
    const published: GenerationModelDescriptor = {
      ...remoteVideoModel('subject-video'),
      inputModes: [...(remoteVideoModel().inputModes ?? []), subjectsMode],
    };
    expect(published.controls.find((control) => control.key === 'referenceMode')?.type).toBe('choice');
    const hero = createSubjectDraft([picture(1), picture(2)], 'Hero', []);
    const saved = subjectDraft(published, [hero]);
    expect(saved.referenceMode).toBe('subjects');
    const reconciled = reconcileCreationDraftWithCatalog(saved, catalogV2([remoteVideoModel('fallback-video-v2'), published]));
    expect(reconciled.warning).toBeNull();
    expect(reconciled.discardedSettingKeys).toEqual([]);
    expect((reconciled.draft as VideoCreationDraft).referenceMode).toBe('subjects');
    expect(buildUnifiedCatalogGenerationRequest(reconciled.draft, published, 'catalog-v2-revision').settings.referenceMode).toBe('subjects');
    // The draft's own check read the control too: "Kling O3 does not support input mode subjects."
    expect(validateCatalogCreationDraft({ ...reconciled.draft, prompt: '@hero waves' } as VideoCreationDraft, published, { credits: 999 }).errors).toEqual([]);
  });

  it('drops subjects when the model switches to one without a slot for them', () => {
    const hero = createSubjectDraft([picture(1), picture(2)], 'Hero', []);
    const plain = remoteVideoModel();
    const moved = applyCatalogModelDefaults(subjectDraft(model, [hero]), plain) as VideoCreationDraft;
    expect(moved.subjects).toEqual([]);
    expect(moved.referenceMode).not.toBe('subjects');
  });

  it('gives a subject a handle no reference or subject holds, and moves it with a rename', () => {
    const hero = createSubjectDraft([picture(1), picture(2)], 'Hero', ['@hero']);
    expect(hero.handle).toBe('@hero_2');
    expect(hero.images.every((image) => image.handle === '@hero_2')).toBe(true);
    const renamed = renameSubjectDraft(hero, 'Lead', ['@hero', hero.handle]);
    expect(renamed.handle).toBe('@lead');
    expect(renamed.images.every((image) => image.handle === '@lead')).toBe(true);
    expect(subjectAsReference(renamed)).toMatchObject({ id: hero.id, displayName: 'Lead', handle: '@lead', url: picture(1).url });
  });

  it('restores a remixed run\'s subjects into a subjects draft', () => {
    const bundle: RemixSourceBundle = {
      generation: { id: 'source', title: 'Hero', prompt: '@hero lifts the serum', category: 'video', model: model.id },
      result: null,
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [],
          subjects: [{
            handle: '@hero',
            displayName: 'Hero',
            images: [1, 2].map((index) => ({
              kind: 'image',
              url: `https://cdn.example.com/hero-${index}.jpg`,
              storagePath: `generation_inputs/owner/source/0${index}-subject_image.jpg`,
              label: 'Hero',
              sourceGenerationId: null,
            })),
          }],
        },
      },
      workflowSettings: { model: model.id },
      restoreIssues: [],
    };
    const catalog = catalogV2([remoteVideoModel('fallback-video-v2'), model]);
    const restored = hydrateCatalogCreationDraftFromRemixSource(createDefaultCreationDraft('video'), bundle, catalog);
    const draft = restored.draft as VideoCreationDraft;
    expect(restored.warning).toBeNull();
    expect(draft.referenceMode).toBe('subjects');
    expect(draft.subjects).toHaveLength(1);
    expect(draft.subjects?.[0]).toMatchObject({ handle: '@hero', displayName: 'Hero' });
    expect(draft.subjects?.[0].images).toHaveLength(2);
    expect(validateCatalogCreationDraft(draft, model, { credits: 999 }).errors).toEqual([]);
  });
});
